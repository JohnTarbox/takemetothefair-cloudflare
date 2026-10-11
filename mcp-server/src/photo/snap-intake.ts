/**
 * OPE-1341 — "Snap booth": a photo uploaded straight from the phone capture page
 * enters the SAME photo-intake lane an emailed photo does.
 *
 * Design rule: no second pipeline. A snap becomes an `inbound_emails` row with
 * `intent='photo_intake'`, and the existing `inbound-email` Workflow dispatches it
 * to the existing photo-intake handler. That keeps everything downstream keyed
 * the way it already is:
 *   - booth proposals are `admin_actions` rows whose `target_id` is the row id,
 *     so `list_photo_proposals` shows snaps exactly as it shows emails;
 *   - `intake_accounting` counts `intent='photo_intake'` rows, so a snap that
 *     stores nothing is visible, not silent;
 *   - the Workflow gives the vision step its 120 s budget and retries (OPE-1262
 *     was a 30 s dispatch timeout — a `waitUntil` here would repeat it).
 *
 * What a snap carries INSTEAD of email headers:
 *   - `routing_source='snap-app'` — provenance, and the handler's eligibility
 *     signal. The upload was authenticated by an ADMIN session in the main app
 *     and reached here over X-Internal-Key; nothing on the email path writes
 *     this value, so it cannot be forged by mail.
 *   - `replies_suppressed_reason` — every send path honours it (OPE-954), so the
 *     Workflow's ack/hold reply is held as `stubbed` instead of emailing John.
 *     The phone reads status from the row instead.
 *   - `to_address = photos+<event-slug>@…` when an event is pinned — the existing
 *     plus-address override, unchanged.
 *   - `capture_meta` — the device location, decided once below.
 *
 * Privacy: the bytes are EXIF-stripped (the shared `stripExifFromJpeg`) BEFORE
 * the R2 put, so the stored object never carries GPS. Location travels in
 * `capture_meta`, which is not public.
 */
import { eq } from "drizzle-orm";
import { stripExifFromJpeg } from "@takemetothefair/utils";
import { inboundEmails } from "../schema.js";
import type { Db } from "../db.js";
import { parseExif, type ExifData } from "./exif.js";
import type { InboundEmailParams } from "../workflows/inbound-email.js";

export const SNAP_ROUTING_SOURCE = "snap-app";
export const SNAP_REPLIES_SUPPRESSED_REASON =
  "snap-app: uploaded from the capture page; status is shown on the phone, not emailed";
const SNAP_MAILBOX_DOMAIN = "meetmeatthefair.com";

/** Same ceiling as the email lane's per-attachment cap (ATTACHMENT_MAX_BYTES). */
export const SNAP_MAX_BYTES = 10 * 1024 * 1024;
const SNAP_ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type LocationSource = "exif" | "device" | "none";

export interface CaptureMeta {
  client_id: string;
  /** ISO timestamp the phone recorded at the shutter. */
  captured_at: string | null;
  location: { latitude: number; longitude: number; accuracy_m: number | null } | null;
  location_source: LocationSource;
  /** Local "YYYY-MM-DD" at the shutter — same semantics as EXIF DateTimeOriginal. */
  taken_on_local_date: string | null;
  event_id: string | null;
  event_slug: string | null;
  note: string | null;
  /** The admin account that uploaded it (from the main app's session). */
  actor: string;
}

/** What the phone sends beside the bytes. Every field optional except client_id. */
export interface SnapClientMeta {
  clientId: string;
  capturedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  takenOnLocalDate?: string | null;
  eventId?: string | null;
  eventSlug?: string | null;
  note?: string | null;
}

export function isSnapRow(row: { routingSource?: string | null }): boolean {
  return row.routingSource === SNAP_ROUTING_SOURCE;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The row id for a snap — derived from the phone's own id for the shot, so a
 * retried upload (offline queue, Background Sync racing the page) lands on the
 * SAME row instead of a second one. That is the whole idempotency mechanism.
 */
export function snapRowId(clientId: string): string | null {
  return UUID_RE.test(clientId) ? `snap-${clientId.toLowerCase()}` : null;
}

function finiteIn(n: unknown, lo: number, hi: number): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/**
 * Decide where the location comes from, ONCE, and record which.
 *
 * EXIF wins when it has both GPS and a date (the ticket's "prefer EXIF when
 * present"); the device fix is the fallback, because Android's capture input and
 * the client's re-encode both drop EXIF. A device fix with no local date still
 * counts — the date falls back to the capture timestamp in America/New_York.
 */
export function decideLocation(
  exif: ExifData,
  client: SnapClientMeta
): Pick<CaptureMeta, "location" | "location_source" | "taken_on_local_date"> {
  const clientDate =
    typeof client.takenOnLocalDate === "string" && LOCAL_DATE_RE.test(client.takenOnLocalDate)
      ? client.takenOnLocalDate
      : localDateFromIso(client.capturedAt ?? null);

  if (exif.gps && exif.takenOnLocalDate) {
    return {
      location: { latitude: exif.gps.latitude, longitude: exif.gps.longitude, accuracy_m: null },
      location_source: "exif",
      taken_on_local_date: exif.takenOnLocalDate,
    };
  }
  const lat = finiteIn(client.latitude, -90, 90);
  const lng = finiteIn(client.longitude, -180, 180);
  if (lat !== null && lng !== null) {
    return {
      location: {
        latitude: lat,
        longitude: lng,
        accuracy_m: finiteIn(client.accuracyM, 0, 100_000),
      },
      location_source: "device",
      taken_on_local_date: exif.takenOnLocalDate ?? clientDate,
    };
  }
  return {
    location: null,
    location_source: "none",
    taken_on_local_date: exif.takenOnLocalDate ?? clientDate,
  };
}

/** "YYYY-MM-DD" of an ISO instant on the New England wall clock. */
export function localDateFromIso(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
  return LOCAL_DATE_RE.test(parts) ? parts : null;
}

export function parseCaptureMeta(json: string | null | undefined): CaptureMeta | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as CaptureMeta;
    return v && typeof v === "object" && typeof v.client_id === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What the photo-intake handler's EXIF thunk returns for a snap: the location
 * decided at ingest. The stored bytes are stripped, so reading them would always
 * come back empty — this is the snap's equivalent of `readExif`.
 */
export function captureMetaAsExif(meta: CaptureMeta | null): ExifData {
  if (!meta) return {};
  const out: ExifData = {};
  if (meta.location) {
    out.gps = { latitude: meta.location.latitude, longitude: meta.location.longitude };
  }
  if (meta.taken_on_local_date && LOCAL_DATE_RE.test(meta.taken_on_local_date)) {
    out.takenOnLocalDate = meta.taken_on_local_date;
  }
  return out;
}

export function snapToAddress(eventSlug: string | null): string {
  return eventSlug && SLUG_RE.test(eventSlug)
    ? `photos+${eventSlug}@${SNAP_MAILBOX_DOMAIN}`
    : `photos@${SNAP_MAILBOX_DOMAIN}`;
}

function extFor(type: string): string {
  return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
}

/** Keep a client-supplied file name to a safe, short R2 key segment. */
function safeName(name: string | null | undefined, type: string): string {
  const base = (name ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "snap"}.${extFor(type)}`;
}

export interface SnapIngestInput {
  bytes: Uint8Array;
  contentType: string;
  fileName?: string | null;
  meta: SnapClientMeta;
  /** The admin account the main app authenticated. */
  actor: string;
}

export interface SnapIngestEnv {
  VENDOR_ASSETS?: R2Bucket;
  INBOUND_EMAIL?: Workflow<InboundEmailParams>;
}

export type SnapIngestResult =
  | {
      ok: true;
      rowId: string;
      deduped: boolean;
      workflowStarted: boolean;
      locationSource: LocationSource;
    }
  | { ok: false; status: number; error: string };

/**
 * Store the shot, write its inbound row, and start the existing Workflow.
 *
 * Order matters for idempotency: the row id is derived from the client id, and
 * an existing row short-circuits BEFORE any R2 write — so a duplicate upload
 * costs one SELECT and creates nothing. The R2 put precedes the insert so a row
 * never points at bytes that are not there.
 */
export async function ingestSnap(
  env: SnapIngestEnv,
  db: Db,
  input: SnapIngestInput,
  now: Date = new Date()
): Promise<SnapIngestResult> {
  const rowId = snapRowId(input.meta.clientId);
  if (!rowId) return { ok: false, status: 400, error: "client_id must be a UUID" };

  const contentType = input.contentType.toLowerCase().split(";")[0].trim();
  const type = contentType === "image/jpg" ? "image/jpeg" : contentType;
  if (!SNAP_ALLOWED_TYPES.has(type)) {
    return { ok: false, status: 415, error: `unsupported content type ${contentType}` };
  }
  if (input.bytes.length === 0) return { ok: false, status: 400, error: "empty file" };
  if (input.bytes.length > SNAP_MAX_BYTES) {
    return { ok: false, status: 413, error: `file exceeds ${SNAP_MAX_BYTES} bytes` };
  }

  const [existing] = await db
    .select({ id: inboundEmails.id, captureMeta: inboundEmails.captureMeta })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, rowId))
    .limit(1);
  if (existing) {
    return {
      ok: true,
      rowId,
      deduped: true,
      workflowStarted: false,
      locationSource: parseCaptureMeta(existing.captureMeta)?.location_source ?? "none",
    };
  }

  const bucket = env.VENDOR_ASSETS;
  if (!bucket) return { ok: false, status: 500, error: "VENDOR_ASSETS not bound" };

  // Read EXIF from the bytes AS RECEIVED (a client that could not re-encode sends
  // the camera original), then strip before anything is stored.
  const exif = type === "image/jpeg" ? parseExif(input.bytes) : {};
  const stored = type === "image/jpeg" ? stripExifFromJpeg(input.bytes).bytes : input.bytes;

  const where = decideLocation(exif, input.meta);
  const eventSlug =
    typeof input.meta.eventSlug === "string" && SLUG_RE.test(input.meta.eventSlug)
      ? input.meta.eventSlug
      : null;
  const note =
    typeof input.meta.note === "string" && input.meta.note.trim()
      ? input.meta.note.trim().slice(0, 200)
      : null;
  const captureMeta: CaptureMeta = {
    client_id: input.meta.clientId.toLowerCase(),
    captured_at: typeof input.meta.capturedAt === "string" ? input.meta.capturedAt : null,
    ...where,
    event_id: eventSlug && typeof input.meta.eventId === "string" ? input.meta.eventId : null,
    event_slug: eventSlug,
    note,
    actor: input.actor,
  };

  const name = safeName(input.fileName, type);
  // Under the same prefix as emailed attachments, so every existing tool
  // (fetch_inbound_attachment, replay, resolve-held, the admin viewer) reads a
  // snap the way it reads an email. The bytes are stripped; see the header.
  const key = `inbound-attachments/${rowId}/0-${name}`;
  await bucket.put(key, stored, {
    httpMetadata: { contentType: type },
    customMetadata: { source: SNAP_ROUTING_SOURCE, actor: input.actor },
  });

  const refs = [{ key, name, mimeType: type, size: stored.length }];
  const inserted = await db
    .insert(inboundEmails)
    .values({
      id: rowId,
      receivedAt: now,
      fromAddress: input.actor,
      toAddress: snapToAddress(eventSlug),
      subject: null,
      intent: "photo_intake",
      status: "received",
      workflowInstanceId: null,
      bodyTextExcerpt: note,
      bodyText: note,
      attachmentCount: 1,
      attachmentRefs: JSON.stringify(refs),
      rawSize: input.bytes.length,
      routingSource: SNAP_ROUTING_SOURCE,
      repliesSuppressedReason: SNAP_REPLIES_SUPPRESSED_REASON,
      captureMeta: JSON.stringify(captureMeta),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: inboundEmails.id });

  if (inserted.length === 0) {
    // A concurrent upload of the same shot won the insert. Its Workflow is the
    // one that runs; this call is the duplicate.
    return {
      ok: true,
      rowId,
      deduped: true,
      workflowStarted: false,
      locationSource: where.location_source,
    };
  }

  // A create failure leaves the row in 'received', which the stale-inbound sweep
  // re-dispatches — the same recovery an email gets. Eligibility does not depend
  // on the params below (the handler reads `routing_source`), so a sweep-started
  // run processes the snap just as this one would.
  let workflowStarted = false;
  if (env.INBOUND_EMAIL) {
    try {
      await env.INBOUND_EMAIL.create({
        params: {
          messageRowId: rowId,
          intent: "photo_intake",
          senderTrust: "trusted",
          emailAuth: "pass",
        },
        retention: { successRetention: "7 days", errorRetention: "7 days" },
      });
      workflowStarted = true;
    } catch {
      workflowStarted = false;
    }
  }

  return {
    ok: true,
    rowId,
    deduped: false,
    workflowStarted,
    locationSource: where.location_source,
  };
}
