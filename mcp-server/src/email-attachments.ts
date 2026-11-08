/**
 * OPE-1579 — attach a file we already store to an outbound email.
 *
 * Bytes never travel with the job: a Cloudflare Queues message is capped at
 * 128 KB and a form is hundreds of KB. The producer validates and enqueues a
 * reference, and the consumer reads the bytes from R2 at send time.
 */
import { eq } from "drizzle-orm";
import { inboundEmails } from "./schema.js";
import type { Db } from "./db.js";
import { sniffAttachmentType } from "./attachment-sniff.js";

/** What a queued email carries for each file. Also the ledger's shape. */
export interface JobAttachment {
  key: string;
  filename: string;
  type: string;
  size: number;
}

export interface AttachmentRequest {
  inbound_email_id: string;
  index: number;
}

/** Email Service caps a message at 25 MiB after base64 (+33%), so 18 MiB raw. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_EMAIL = 10;

/** Decided from the file's bytes. Never a forwarded .eml or anything else. */
function isSendableType(type: string): boolean {
  return type === "application/pdf" || type.startsWith("image/");
}

type Resolved = { ok: true; attachments: JobAttachment[] } | { ok: false; message: string };

/**
 * Turn requests into validated references, or refuse the whole set. All or
 * nothing: a reply promising two forms must not go out with one.
 */
export async function resolveAttachments(
  db: Db,
  bucket: R2Bucket | undefined,
  requests: AttachmentRequest[]
): Promise<Resolved> {
  if (requests.length > MAX_ATTACHMENTS_PER_EMAIL) {
    return { ok: false, message: `At most ${MAX_ATTACHMENTS_PER_EMAIL} attachments per email.` };
  }
  if (!bucket) return { ok: false, message: "VENDOR_ASSETS binding is not available." };

  const attachments: JobAttachment[] = [];
  let total = 0;
  for (const req of requests) {
    const label = `attachment ${req.index} of inbound ${req.inbound_email_id}`;
    const [row] = await db
      .select({ refs: inboundEmails.attachmentRefs })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, req.inbound_email_id))
      .limit(1);
    if (!row) return { ok: false, message: `${label}: no such inbound email.` };

    const refs = JSON.parse(row.refs ?? "[]") as Array<{ key: string; name: string }>;
    const ref = refs[req.index];
    if (!ref) return { ok: false, message: `${label}: it has only ${refs.length} attachment(s).` };

    const object = await bucket.get(ref.key);
    if (!object) return { ok: false, message: `${label}: the file is missing from storage.` };
    const bytes = new Uint8Array(await object.arrayBuffer());

    // OPE-1364 — trust the bytes, not the stored or declared type.
    const type = sniffAttachmentType(bytes);
    if (!type || !isSendableType(type)) {
      return { ok: false, message: `${label} (${ref.name}): only images and PDFs can be sent.` };
    }

    total += bytes.byteLength;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      return {
        ok: false,
        message: `Attachments total more than ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MiB.`,
      };
    }
    attachments.push({ key: ref.key, filename: ref.name, type, size: bytes.byteLength });
  }
  return { ok: true, attachments };
}

/** Consumer side: read the bytes for a queued email. Null names what's missing. */
export async function loadJobAttachments(
  bucket: R2Bucket | undefined,
  attachments: JobAttachment[]
): Promise<{ ok: true; files: EmailAttachment[] } | { ok: false; error: string }> {
  if (!bucket) return { ok: false, error: "attachment unavailable: no VENDOR_ASSETS binding" };
  const files: EmailAttachment[] = [];
  for (const a of attachments) {
    const object = await bucket.get(a.key);
    if (!object) return { ok: false, error: `attachment unavailable: ${a.key}` };
    files.push({
      content: await object.arrayBuffer(),
      filename: a.filename,
      type: a.type,
      disposition: "attachment",
    });
  }
  return { ok: true, files };
}
