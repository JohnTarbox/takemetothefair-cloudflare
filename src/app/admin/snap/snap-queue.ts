/**
 * OPE-1341 — the snap page's offline queue and image prep (browser only).
 *
 * The IndexedDB layout is shared with the service worker (public/snap-sw.js),
 * which does the uploading: DB "snap-queue" v1, store "shots", keyPath
 * "clientId". Keep the two in sync.
 */

export const SNAP_DB = "snap-queue";
const SNAP_DB_VERSION = 1;
const STORE = "shots";
export const SNAP_SYNC_TAG = "snap-flush";

/** Long edge and quality: the recipe proven 17/17 on 2026-09-12. */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;
const THUMB_EDGE = 160;

export interface SnapMeta {
  clientId: string;
  capturedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  takenOnLocalDate: string;
  eventId: string | null;
  eventSlug: string | null;
  note: string | null;
}

export interface QueuedShot {
  clientId: string;
  blob: Blob;
  fileName: string;
  meta: SnapMeta;
  thumb: string;
  createdAt: number;
  /** Set by the service worker when the server refused the shot (4xx). */
  rejectedStatus?: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SNAP_DB, SNAP_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "clientId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(req ? req.result : undefined);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      })
  );
}

export const queue = {
  put: (shot: QueuedShot) => run("readwrite", (s) => s.put(shot)),
  remove: (clientId: string) => run("readwrite", (s) => s.delete(clientId)),
  all: async () => ((await run<QueuedShot[]>("readonly", (s) => s.getAll())) ?? []) as QueuedShot[],
};

/** The phone's own wall-clock date — EXIF DateTimeOriginal semantics. */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Fit (w, h) inside a square of `edge`, never upscaling. */
export function fitWithin(w: number, h: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * Resize to 2000 px / JPEG q85 with orientation applied to the PIXELS, plus a
 * small thumbnail. Re-encoding drops EXIF (GPS included) — location travels in
 * the meta instead. If the browser cannot decode the file (e.g. HEIC), the
 * original is sent; the server reads its EXIF and strips it before storing.
 */
export async function prepareImage(
  file: File
): Promise<{ blob: Blob; thumb: string; resized: boolean }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { blob: file, thumb: "", resized: false };
  }
  const full = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = full.width;
  canvas.height = full.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, full.width, full.height);
  const blob = await toBlob(canvas, JPEG_QUALITY);

  const t = fitWithin(bitmap.width, bitmap.height, THUMB_EDGE);
  const tc = document.createElement("canvas");
  tc.width = t.width;
  tc.height = t.height;
  tc.getContext("2d")!.drawImage(bitmap, 0, 0, t.width, t.height);
  const thumb = tc.toDataURL("image/jpeg", 0.6);
  bitmap.close();

  return blob ? { blob, thumb, resized: true } : { blob: file, thumb, resized: false };
}
