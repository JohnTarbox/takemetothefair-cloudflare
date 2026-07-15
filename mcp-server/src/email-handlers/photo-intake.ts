/**
 * OPE-202 — `photo_intake` handler for photos@meetmeatthefair.com.
 *
 * Milestone 1 (rails/skeleton): receive on-site fair photos, gate on
 * authentication + sender trust, and acknowledge. NO public writes here — the
 * vendor-creation tail is downstream (OPE-204), which carries the OPE-6 gate.
 *
 * By the time this runs, the entrypoint (email-handler.ts) has already captured
 * the image/PDF attachments to R2 (OPE-68 path → attachment_count /
 * attachment_refs on the row) and recorded the inbound_emails row. This handler
 * only decides the ack:
 *   - authenticated (SPF/DKIM/DMARC pass) AND trusted sender → "received N
 *     photos", eligible for downstream vendor processing.
 *   - anything else → received + held for review, NOT eligible for auto-write.
 * Both replies include the operational tip to send photos at FULL SIZE as
 * attachments so EXIF (GPS + timestamp) survives — the downstream fair-resolver
 * (OPE-203) reads that EXIF.
 *
 * The `photos+<event-slug>@` sub-address is parsed here from the recipient and
 * echoed back as an explicit event hint (persisted on the row via to_address,
 * consumed by OPE-203).
 */
import type { HandlerFn, HandlerResult } from "./types.js";
import { parsePlusSegment } from "../email-intents.js";

interface AttachmentRef {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Count image attachments from the captured refs, falling back to the raw
 *  attachment_count when refs are absent/unparseable. */
function countPhotos(attachmentRefs: string | null, attachmentCount: number): number {
  if (!attachmentRefs) return attachmentCount;
  try {
    const refs = JSON.parse(attachmentRefs) as AttachmentRef[];
    if (!Array.isArray(refs)) return attachmentCount;
    const images = refs.filter(
      (r) => typeof r?.mimeType === "string" && r.mimeType.toLowerCase().startsWith("image/")
    ).length;
    return images > 0 ? images : attachmentCount;
  } catch {
    return attachmentCount;
  }
}

export const handle: HandlerFn = async (_env, ctx, row): Promise<HandlerResult> => {
  const photoCount = countPhotos(row.attachmentRefs, row.attachmentCount);
  const eventHint = parsePlusSegment(row.toAddress);

  // Eligible for downstream auto-write ONLY when the message is authenticated
  // (SPF/DKIM/DMARC pass) AND from a trusted sender. Everything else is held for
  // human review — no eligibility for the OPE-204 vendor write.
  const eligible = ctx.emailAuth === "pass" && ctx.senderTrust === "trusted";

  return {
    replyKind: eligible ? "photo-intake-ack" : "photo-intake-held",
    replyParams: {
      subject: row.subject ?? "",
      photoCount,
      eventHint: eventHint ?? null,
      authVerdict: ctx.emailAuth,
      trust: ctx.senderTrust,
    },
    status: "replied",
  };
};
