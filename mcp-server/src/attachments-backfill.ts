/**
 * OPE-1578 — recover attachments an email lost to the old count cap.
 *
 * Before OPE-1578 the cap decided what was stored, so a skipped part exists
 * only inside the forwarded `.eml` we kept. This re-opens that `.eml` and stores
 * those parts as their own refs, under the same rules as live capture: type from
 * the bytes, never overwrite, downloaded rather than rendered.
 *
 * Only `over-count-cap` skips that are not signature furniture are candidates.
 * Dry-run unless `commit` is true.
 */
import PostalMime from "postal-mime";
import { eq } from "drizzle-orm";
import { inboundEmails } from "./schema.js";
import type { Db } from "./db.js";
import { sniffAttachmentType } from "./attachment-sniff.js";
import { POSTAL_MIME_OPTIONS } from "./email-handlers/forwarded-message.js";
import {
  ATTACHMENT_MAX_BYTES,
  sanitizeAttachmentName,
  type AttachmentRef,
  type AttachmentSkip,
} from "./email-handler.js";

export type BackfillOutcome =
  | "stored"
  | "would-store"
  | "not-found-in-eml"
  | "too-large"
  | "unrecognized-content"
  | "already-exists";

export interface BackfillResult {
  inbound_email_id: string;
  committed: boolean;
  /** Candidates examined, so "nothing to do" can't hide a matcher that missed. */
  candidates: number;
  error?: string;
  items: Array<{ index: number; name: string; outcome: BackfillOutcome; key?: string }>;
}

function toBytes(content: unknown): Uint8Array | null {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return null;
}

export async function backfillSkippedAttachments(
  db: Db,
  bucket: R2Bucket,
  inboundEmailId: string,
  commit: boolean
): Promise<BackfillResult> {
  const result: BackfillResult = {
    inbound_email_id: inboundEmailId,
    committed: false,
    candidates: 0,
    items: [],
  };
  const fail = (error: string) => ({ ...result, error });

  const [row] = await db
    .select({ refs: inboundEmails.attachmentRefs, skips: inboundEmails.attachmentSkips })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);
  if (!row) return fail("inbound email not found");

  const refs = JSON.parse(row.refs ?? "[]") as AttachmentRef[];
  const skips = JSON.parse(row.skips ?? "[]") as AttachmentSkip[];
  const candidates = skips.filter((s) => s.reason === "over-count-cap" && s.furniture !== true);
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  const eml = refs.find((r) => r.mimeType === "message/rfc822");
  if (!eml) return fail("no stored .eml to recover from");
  const object = await bucket.get(eml.key);
  if (!object) return fail(`stored .eml is missing from R2: ${eml.key}`);

  const raw = await object.arrayBuffer();
  const parsed = await PostalMime.parse(raw, POSTAL_MIME_OPTIONS);
  const parts = parsed.attachments.map((a, i) => ({
    name: sanitizeAttachmentName(a.filename ?? null, i),
    bytes: toBytes(a.content),
  }));

  // Every ref shares the delivery's group prefix: inbound-attachments/<group>/…
  const prefix = eml.key.slice(0, eml.key.lastIndexOf("/") + 1);
  const recovered = new Set<number>();

  for (const skip of candidates) {
    const item = { index: skip.index, name: skip.name };
    const part = parts.find((p) => p.name === skip.name);
    if (!part?.bytes) {
      result.items.push({ ...item, outcome: "not-found-in-eml" });
      continue;
    }
    if (part.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      result.items.push({ ...item, outcome: "too-large" });
      continue;
    }
    // OPE-1364 — the bytes decide the type, never the declared header.
    const storedType = sniffAttachmentType(part.bytes);
    if (!storedType) {
      result.items.push({ ...item, outcome: "unrecognized-content" });
      continue;
    }
    const key = `${prefix}${skip.index}-${skip.name}`;
    if (await bucket.head(key)) {
      result.items.push({ ...item, outcome: "already-exists", key });
      continue;
    }
    if (!commit) {
      result.items.push({ ...item, outcome: "would-store", key });
      continue;
    }
    await bucket.put(key, part.bytes, {
      httpMetadata: { contentType: storedType, contentDisposition: "attachment" },
    });
    refs.push({
      key,
      name: skip.name,
      mimeType: storedType,
      size: part.bytes.byteLength,
      ocrSkipped: true,
    });
    recovered.add(skip.index);
    result.items.push({ ...item, outcome: "stored", key });
  }

  if (commit && recovered.size > 0) {
    const nextSkips = skips.map((s) =>
      recovered.has(s.index) && s.reason === "over-count-cap"
        ? { ...s, reason: "ocr-skipped:over-count-cap" as const }
        : s
    );
    await db
      .update(inboundEmails)
      .set({ attachmentRefs: JSON.stringify(refs), attachmentSkips: JSON.stringify(nextSkips) })
      .where(eq(inboundEmails.id, inboundEmailId));
    result.committed = true;
  }
  return result;
}
