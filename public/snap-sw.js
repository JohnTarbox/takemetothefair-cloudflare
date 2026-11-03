/*
 * OPE-1341 — service worker for the snap capture page (/admin/snap).
 *
 * Its one job is the offline queue: shots the page saved to IndexedDB are
 * uploaded here, on a Background Sync event, on an explicit "flush" message from
 * the page (on open, on `online`, after each shot), and never deleted until the
 * server has confirmed them. The server is idempotent on `clientId`, so a shot
 * uploaded twice (sync racing the page, a lost response) still makes ONE row.
 *
 * Plain JS on purpose: a service worker is served as a static file and is not
 * bundled. The IndexedDB layout is shared with src/app/admin/snap/snap-queue.ts —
 * keep DB_NAME / STORE / the record shape in sync with it.
 */
const DB_NAME = "snap-queue";
const DB_VERSION = 1;
const STORE = "shots";
const SYNC_TAG = "snap-flush";
const UPLOAD_URL = "/api/admin/snap/upload";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "clientId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

async function notify(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const c of clients) c.postMessage(message);
}

let flushing = null;

/** Upload every queued shot, oldest first. Resolves to the number still queued. */
function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    const db = await openDb();
    const shots = ((await tx(db, "readonly", (s) => s.getAll())) || []).filter(
      (x) => !x.rejectedStatus
    );
    shots.sort((a, b) => a.createdAt - b.createdAt);
    let remaining = shots.length;
    for (const shot of shots) {
      const form = new FormData();
      form.set("file", shot.blob, shot.fileName || "snap.jpg");
      form.set("meta", JSON.stringify(shot.meta));
      let res;
      try {
        res = await fetch(UPLOAD_URL, { method: "POST", body: form, credentials: "same-origin" });
      } catch (err) {
        // Offline or the request died: leave it queued; the next trigger retries.
        await notify({ type: "snap-upload-error", clientId: shot.clientId, error: String(err) });
        break;
      }
      if (res.ok) {
        // ONLY a confirmed upload leaves the queue.
        await tx(db, "readwrite", (s) => s.delete(shot.clientId));
        remaining -= 1;
        await notify({ type: "snap-uploaded", clientId: shot.clientId });
      } else if (res.status === 401 || res.status === 403) {
        // Signed out: keep everything, tell the page; retrying is pointless.
        await notify({ type: "snap-auth-required" });
        break;
      } else if (
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408 &&
        res.status !== 429
      ) {
        // The server refused THIS shot (bad type, too big). Retrying cannot fix
        // it, and it must not block the rest — but it is NOT deleted: nothing
        // leaves the queue without a confirmation. It is parked, shown on the
        // page as rejected, and only a person removes it.
        await tx(db, "readwrite", (s) => s.put({ ...shot, rejectedStatus: res.status }));
        remaining -= 1;
        await notify({ type: "snap-rejected", clientId: shot.clientId, status: res.status });
      } else {
        // 5xx / 408 / 429: transient. Stop; a later trigger retries in order.
        await notify({
          type: "snap-upload-error",
          clientId: shot.clientId,
          error: `HTTP ${res.status}`,
        });
        break;
      }
    }
    db.close();
    await notify({ type: "snap-queue", remaining });
    return remaining;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) {
    // A rejection here asks the browser to retry the sync later with backoff.
    event.waitUntil(
      flush().then((remaining) => {
        if (remaining > 0) throw new Error(`${remaining} snaps still queued`);
      })
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "snap-flush") event.waitUntil(flush());
});
