/**
 * OPE-1580 — blank vendor forms posted to an event page.
 *
 * Some organizers only email their application packet. A person may post the
 * blank forms to that year's event page. Nothing here posts automatically:
 * inbound attachments include filled-in applications with personal and payment
 * details.
 */

export const EVENT_DOCUMENT_KINDS = ["application", "rules", "license", "raffle", "other"] as const;
export type EventDocumentKind = (typeof EVENT_DOCUMENT_KINDS)[number];

export const EVENT_DOCUMENT_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export type EventDocumentMimeType = (typeof EVENT_DOCUMENT_MIME_TYPES)[number];

export function isEventDocumentMimeType(v: string | null): v is EventDocumentMimeType {
  return v !== null && (EVENT_DOCUMENT_MIME_TYPES as readonly string[]).includes(v);
}

const EXTENSION: Record<EventDocumentMimeType, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

export function eventDocumentExtension(mime: EventDocumentMimeType): string {
  return EXTENSION[mime];
}

const DAY_MS = 86_400_000;

/** A form goes away once the event's end date has passed. Dates are stored at
 *  varying hours of the day, so one full day after it is always past it. */
export function eventDocumentExpiresAt(endDate: Date): Date {
  return new Date(endDate.getTime() + DAY_MS);
}

export function isEventDocumentLive(
  doc: { status: string; expiresAt: Date },
  now: Date = new Date()
): boolean {
  return doc.status === "live" && doc.expiresAt.getTime() > now.getTime();
}

/** "Received from UMF Conferences and Events, September 2026" */
export function eventDocumentProvenance(organizer: string, receivedAt: Date): string {
  const when = receivedAt.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "America/New_York",
  });
  return `Received from ${organizer}, ${when}`;
}

/** "PDF, 395 KB" */
export function eventDocumentTypeAndSize(mime: string, bytes: number): string {
  const type = mime === "application/pdf" ? "PDF" : mime === "image/png" ? "PNG" : "JPEG";
  const size =
    bytes >= 1_048_576
      ? `${(bytes / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${type}, ${size}`;
}

const PNG_SIGNATURE_LENGTH = 8;
/** Chunks that carry text, timestamps or EXIF. Everything else is image data. */
const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/**
 * Remove metadata chunks from a PNG. Returns the input unchanged if it is not
 * a well-formed PNG: the caller has already sniffed the type, and a chunk
 * layout we can't walk is not one we should rewrite.
 */
export function stripPngMetadata(input: Uint8Array): {
  bytes: Uint8Array;
  chunksRemoved: number;
} {
  const unchanged = { bytes: input, chunksRemoved: 0 };
  if (input.length < PNG_SIGNATURE_LENGTH || input[0] !== 0x89) return unchanged;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const keep: Array<[number, number]> = [[0, PNG_SIGNATURE_LENGTH]];
  let offset = PNG_SIGNATURE_LENGTH;
  let chunksRemoved = 0;
  let sawEnd = false;
  while (offset + 12 <= input.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > input.length) return unchanged;
    const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8));
    if (PNG_METADATA_CHUNKS.has(type)) chunksRemoved++;
    else keep.push([offset, end]);
    offset = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return unchanged;
  const total = keep.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [a, b] of keep) {
    out.set(input.subarray(a, b), at);
    at += b - a;
  }
  return { bytes: out, chunksRemoved };
}
