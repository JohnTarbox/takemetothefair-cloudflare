"use client";

/**
 * OPE-1341 — the snap capture surface. Open → Snap → shutter: the photo is
 * resized on the phone, queued in IndexedDB, and uploaded by the service worker
 * (now, or when the signal comes back). Each thumbnail then shows what the
 * photo-intake lane did with it, read from the server.
 *
 * Full-screen over the admin shell (the shell's desktop sidebar is unusable at
 * phone width); auth is still the admin layout's ADMIN check.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  localDate,
  newClientId,
  prepareImage,
  queue,
  SNAP_SYNC_TAG,
  type QueuedShot,
} from "./snap-queue";
import { LOCATION_BLOCKED_HELP, locationLine, type GeoState } from "@/lib/snap/location-status";

interface NearbyEvent {
  id: string;
  slug: string;
  name: string;
  venueName: string;
  /** null in the location-free day list. */
  distanceMiles: number | null;
  atVenue: boolean;
}

/** A position copied into plain numbers the moment it arrives (OPE-1549). */
interface Fix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  at: number;
}

interface Pin {
  id: string;
  slug: string;
  name: string;
}

interface SnapStatus {
  id: string;
  phase: "processing" | "matched" | "held" | "poster" | "failed";
  label: string;
}

interface SentShot {
  clientId: string;
  thumb: string;
  createdAt: number;
}

const PIN_KEY = "snap-pin";
const SENT_KEY = "snap-sent";
const SENT_KEEP = 30;
const FIX_MAX_AGE_MS = 2 * 60 * 1000;

function readJson<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage: () => Storage, key: string, value: unknown) {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the queue itself lives in IndexedDB */
  }
}

const rowId = (clientId: string) => `snap-${clientId}`;

export function SnapCapture() {
  const fileInput = useRef<HTMLInputElement>(null);
  const fix = useRef<Fix | null>(null);
  const [geoState, setGeoState] = useState<GeoState>("pending");
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [geoAttempt, setGeoAttempt] = useState(0);
  const [showBlockedHelp, setShowBlockedHelp] = useState(false);
  const [nearby, setNearby] = useState<NearbyEvent[] | null>(null);
  const [today, setToday] = useState<NearbyEvent[] | null>(null);
  const [query, setQuery] = useState("");
  const [pin, setPin] = useState<Pin | null>(null);
  const [pinChoice, setPinChoice] = useState<"unset" | "pinned" | "server">("unset");
  const [showPicker, setShowPicker] = useState(false);
  const [note, setNote] = useState("");
  const [queued, setQueued] = useState<QueuedShot[]>([]);
  const [sent, setSent] = useState<SentShot[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SnapStatus>>({});
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    try {
      setQueued(await queue.all());
    } catch {
      setBanner("This browser cannot store photos offline; keep the signal on while snapping.");
    }
  }, []);

  /** Ask the service worker to upload; fall back to Background Sync registration. */
  const flush = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: "snap-flush" });
    try {
      await (
        reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }
      ).sync?.register(SNAP_SYNC_TAG);
    } catch {
      /* Background Sync unsupported — the online/open triggers still flush */
    }
  }, []);

  // Restore session state, register the worker, and flush whatever is waiting.
  useEffect(() => {
    const savedPin = readJson<Pin | "server" | null>(() => sessionStorage, PIN_KEY, null);
    if (savedPin === "server") setPinChoice("server");
    else if (savedPin) {
      setPin(savedPin);
      setPinChoice("pinned");
    }
    setSent(readJson<SentShot[]>(() => localStorage, SENT_KEY, []));
    void refreshQueue();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/snap-sw.js", { scope: "/admin/snap" })
        .then(() => flush())
        .catch(() => setBanner("Offline queue unavailable (service worker did not register)."));
      const onMessage = (e: MessageEvent) => {
        const m = e.data as { type?: string };
        if (
          m?.type === "snap-uploaded" ||
          m?.type === "snap-rejected" ||
          m?.type === "snap-queue"
        ) {
          void refreshQueue();
        } else if (m?.type === "snap-auth-required") {
          setBanner("Signed out — sign in again; your photos are still queued.");
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      const onOnline = () => void flush();
      window.addEventListener("online", onOnline);
      return () => {
        navigator.serviceWorker.removeEventListener("message", onMessage);
        window.removeEventListener("online", onOnline);
      };
    }
    setBanner("This browser has no service worker; photos upload only while this page is open.");
    return undefined;
  }, [flush, refreshQueue]);

  // OPE-1549 — today's full list for "Pick the fair". Location-free on purpose:
  // the manual pin must work with location denied or unavailable.
  useEffect(() => {
    fetch(`/api/admin/snap/nearby?${new URLSearchParams({ date: localDate() })}`, {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ events?: NearbyEvent[] }>) : { events: [] }))
      .then((j) => setToday(j.events ?? []))
      .catch(() => setToday([]));
  }, []);

  // Keep a fresh location fix and offer the nearest event running today.
  // OPE-1549: a cold GPS fix indoors can take well over 10 s, so the precise
  // watch gets 30 s and a 60 s maximumAge; on timeout/unavailable a one-shot
  // coarse (network) fix is tried rather than giving up with nothing.
  // `geoAttempt` re-runs this when "Location blocked: tap to fix" is tapped.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeoState("unavailable");
      return;
    }
    setGeoState((g) => (g === "ok" ? g : "pending"));
    let asked = false;
    let triedCoarse = false;
    const onFix = (pos: GeolocationPosition) => {
      fix.current = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
        at: pos.timestamp || Date.now(),
      };
      setAccuracyM(pos.coords.accuracy);
      setGeoState("ok");
      setShowBlockedHelp(false);
      if (asked) return;
      asked = true;
      const q = new URLSearchParams({
        lat: String(pos.coords.latitude),
        lng: String(pos.coords.longitude),
        date: localDate(),
      });
      fetch(`/api/admin/snap/nearby?${q}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ events?: NearbyEvent[] }>) : { events: [] }))
        .then((j) => setNearby(j.events ?? []))
        .catch(() => setNearby([]));
    };
    const onError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setGeoState("denied");
        return;
      }
      if (fix.current) return; // a later watch error keeps the last good fix
      setGeoState("unavailable");
      if (!triedCoarse) {
        triedCoarse = true;
        navigator.geolocation.getCurrentPosition(onFix, () => undefined, {
          enableHighAccuracy: false,
          maximumAge: 5 * 60_000,
          timeout: 30_000,
        });
      }
    };
    const id = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true,
      maximumAge: 60_000,
      timeout: 30_000,
    });
    return () => navigator.geolocation.clearWatch(id);
  }, [geoAttempt]);

  // Suggest (do not force) the nearest event at this venue as the pin.
  const suggested = nearby?.find((e) => e.atVenue) ?? null;
  const effectivePin: Pin | null =
    pinChoice === "pinned" ? pin : pinChoice === "server" ? null : suggested;

  // Nearest first when there is a fix, then every other event running today
  // (alphabetical); the search box filters both.
  const nearIds = new Set((nearby ?? []).map((e) => e.id));
  const q = query.trim().toLowerCase();
  const pickList = [...(nearby ?? []), ...(today ?? []).filter((e) => !nearIds.has(e.id))].filter(
    (e) => !q || e.name.toLowerCase().includes(q) || e.venueName.toLowerCase().includes(q)
  );
  const line = locationLine({
    geo: geoState,
    accuracyM,
    atEventName: suggested?.name ?? null,
  });
  const onLineTap = () => {
    if (line.action === "retry") {
      setShowBlockedHelp(true);
      setGeoAttempt((n) => n + 1);
    } else if (line.action === "pick") {
      setShowPicker(true);
    }
  };

  const choosePin = (p: Pin | "server") => {
    if (p === "server") {
      setPin(null);
      setPinChoice("server");
    } else {
      setPin(p);
      setPinChoice("pinned");
    }
    writeJson(() => sessionStorage, PIN_KEY, p);
    setShowPicker(false);
    setQuery("");
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const clientId = newClientId();
        const pos = fix.current;
        const fresh = pos && Date.now() - pos.at < FIX_MAX_AGE_MS ? pos : null;
        const { blob, thumb } = await prepareImage(file);
        const shot: QueuedShot = {
          clientId,
          blob,
          fileName: file.name || "snap.jpg",
          thumb,
          createdAt: Date.now(),
          meta: {
            clientId,
            capturedAt: new Date().toISOString(),
            latitude: fresh ? fresh.latitude : null,
            longitude: fresh ? fresh.longitude : null,
            accuracyM: fresh ? Math.round(fresh.accuracyM) : null,
            takenOnLocalDate: localDate(),
            eventId: effectivePin?.id ?? null,
            eventSlug: effectivePin?.slug ?? null,
            note: note.trim() || null,
          },
        };
        await queue.put(shot);
        setSent((prev) => {
          const next = [{ clientId, thumb, createdAt: shot.createdAt }, ...prev].slice(
            0,
            SENT_KEEP
          );
          writeJson(() => localStorage, SENT_KEY, next);
          return next;
        });
      }
      setNote("");
      await refreshQueue();
      await flush();
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // Poll the server for every sent shot that is no longer queued and not final.
  useEffect(() => {
    const queuedIds = new Set(queued.map((q) => q.clientId));
    const pending = sent
      .filter((s) => !queuedIds.has(s.clientId))
      .map((s) => rowId(s.clientId))
      .filter((id) => !statuses[id] || statuses[id].phase === "processing");
    if (pending.length === 0) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/snap/status?ids=${pending.join(",")}`, {
          credentials: "same-origin",
        });
        if (!r.ok) return;
        const j = (await r.json()) as { statuses: SnapStatus[] };
        setStatuses((prev) => {
          const next = { ...prev };
          for (const s of j.statuses) next[s.id] = s;
          return next;
        });
      } catch {
        /* offline — try again next tick */
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [sent, queued, statuses]);

  const waiting = queued.filter((q) => !q.rejectedStatus).length;
  const rejected = new Map(
    queued.filter((q) => q.rejectedStatus).map((q) => [q.clientId, q.rejectedStatus!])
  );
  const queuedIds = new Set(queued.map((q) => q.clientId));

  const lineFor = (s: SentShot): { text: string; tone: string } => {
    const rej = rejected.get(s.clientId);
    if (rej) return { text: `Rejected by the server (HTTP ${rej})`, tone: "text-red-300" };
    if (queuedIds.has(s.clientId)) return { text: "Waiting to send…", tone: "text-amber-300" };
    const st = statuses[rowId(s.clientId)];
    if (!st) return { text: "Uploaded", tone: "text-gray-300" };
    const tone =
      st.phase === "matched"
        ? "text-green-300"
        : st.phase === "held" || st.phase === "failed"
          ? "text-red-300"
          : "text-gray-300";
    return { text: st.label, tone };
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-900 text-white">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold">Snap booth</h1>
        <span
          className={`rounded-full px-3 py-1 text-sm ${waiting ? "bg-amber-500 text-black" : "bg-gray-700"}`}
          aria-live="polite"
        >
          {waiting ? `${waiting} waiting to send` : "All sent"}
        </span>
      </header>

      <section className="px-4 pb-3" aria-label="Which fair">
        <button
          type="button"
          onClick={onLineTap}
          disabled={line.action === "none"}
          aria-live="polite"
          data-testid="snap-location-line"
          className={`mb-2 w-full rounded-lg px-4 py-2 text-left text-sm disabled:cursor-default ${
            line.tone === "good"
              ? "bg-green-900/60 text-green-200"
              : line.tone === "bad"
                ? "bg-red-900/60 text-red-200"
                : line.tone === "warn"
                  ? "bg-amber-900/60 text-amber-200"
                  : "bg-gray-800 text-gray-300"
          }`}
        >
          {line.text}
        </button>
        {showBlockedHelp && geoState === "denied" && (
          <p className="mb-2 text-xs text-gray-300">{LOCATION_BLOCKED_HELP}</p>
        )}
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          className="w-full rounded-lg bg-gray-800 px-4 py-3 text-left"
        >
          <span className="block text-xs uppercase tracking-wide text-gray-400">
            {pinChoice === "pinned"
              ? "Pinned"
              : pinChoice === "server"
                ? "Fair"
                : suggested
                  ? "You're at"
                  : "Fair"}
          </span>
          <span className="block text-base">
            {effectivePin
              ? effectivePin.name
              : pinChoice === "server"
                ? "Let the server decide"
                : "Tap to pick the fair"}
          </span>
        </button>
        {showPicker && (
          <div className="mt-2 rounded-lg bg-gray-800">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search today's fairs"
              aria-label="Search today's fairs"
              className="w-full rounded-t-lg bg-gray-700 px-4 py-3 text-base placeholder-gray-400"
            />
            <ul className="max-h-56 overflow-y-auto">
              {today === null && nearby === null && (
                <li className="px-4 py-3 text-sm text-gray-400">Loading today&apos;s fairs…</li>
              )}
              {today !== null && pickList.length === 0 && (
                <li className="px-4 py-3 text-sm text-gray-400">
                  {q ? "No fair today matches that." : "No public fairs are listed for today."}
                </li>
              )}
              {pickList.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="w-full px-4 py-3 text-left hover:bg-gray-700"
                    onClick={() => choosePin({ id: e.id, slug: e.slug, name: e.name })}
                  >
                    {e.name}
                    <span className="block text-xs text-gray-400">
                      {e.venueName}
                      {e.distanceMiles !== null ? ` · ${e.distanceMiles} mi` : ""}
                    </span>
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="w-full px-4 py-3 text-left text-gray-300 hover:bg-gray-700"
                  onClick={() => choosePin("server")}
                >
                  Let the server decide
                </button>
              </li>
            </ul>
          </div>
        )}
      </section>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          className="h-40 w-40 rounded-full bg-white text-xl font-bold text-gray-900 shadow-lg active:scale-95 disabled:opacity-60"
        >
          {busy ? "Saving…" : sent.length ? "Snap another" : "Snap"}
        </button>
        <input
          type="text"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (e.g. Smith Pottery, row C)"
          className="w-full max-w-md rounded-lg bg-gray-800 px-4 py-3 text-base placeholder-gray-500"
        />
        {banner && <p className="max-w-md text-center text-sm text-amber-300">{banner}</p>}
      </div>

      {sent.length > 0 && (
        <ul
          className="max-h-[38vh] overflow-y-auto border-t border-gray-800 px-4 py-2"
          aria-label="Recent snaps"
        >
          {sent.map((s) => {
            const line = lineFor(s);
            return (
              <li key={s.clientId} className="flex items-center gap-3 py-2">
                {s.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local data: thumbnail, never a remote image
                  <img
                    src={s.thumb}
                    alt=""
                    width={56}
                    height={56}
                    className="h-14 w-14 rounded object-cover"
                  />
                ) : (
                  <div className="h-14 w-14 rounded bg-gray-700" />
                )}
                <span className={`text-sm ${line.tone}`}>{line.text}</span>
                {rejected.has(s.clientId) && (
                  <button
                    type="button"
                    className="ml-auto text-xs text-gray-400 underline"
                    onClick={() => void queue.remove(s.clientId).then(refreshQueue)}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
