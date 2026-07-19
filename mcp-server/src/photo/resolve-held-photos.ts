/**
 * OPE-254 Defect 2 + rescue — recover a held `photo-intake-unresolved` batch
 * once the fair is known.
 *
 * OPE-203 holds a no-GPS photo email and asks John to name the fair. Two
 * recovery paths converge here:
 *
 *   1. **Reply → resolve** (Defect 2). John replies to the hold naming the
 *      fair; the correction handler calls `resolveHeldPhotosFromReply`, which
 *      threads the reply back to the held parent(s) and attaches their photos.
 *   2. **One-shot admin resolve** (the rescue). An internal endpoint calls
 *      `resolveHeldPhotoEmail` directly for a known set of held rows + event —
 *      the escape hatch the ticket allows for the 9 already-stranded 2026-07-17
 *      photos, whose original replies predate the handler.
 *
 * ── Why attach as GENERAL gallery photos, not via runBoothPipeline ──────────
 * `runBoothPipeline` (booth vision + OPE-205 §3 gallery) is gated OFF by
 * default (`PHOTO_VISION_ENABLED="false"` in prod), so it would attach nothing.
 * A fair John has NAMED needs no vision to know these are his general on-site
 * photos, so we attach every image straight to the event gallery via
 * `attachGeneralPhotos` (image_role="gallery" → appends `event_photos`, never
 * touches `events.image_url`, so an existing hero is safe by construction).
 * Booth auto-write stays the separate, gated enhancement it is.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `attachGeneralPhotos` is NOT dedup'd — attaching twice duplicates rows. Guard:
 * a resolved parent carries `resulting_event_id`; we skip it, and only mark a
 * parent resolved once at least one photo attached. So a second reply (John
 * sent two) finds no unresolved parents and no-ops.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { InboundEmail } from "@takemetothefair/db-schema";
import { inboundEmails } from "../schema.js";
import type { Db } from "../db.js";
import type { HandlerCtx } from "../email-handlers/types.js";
import {
  parseRefs,
  imageRefs,
  findOverrideEvent,
  findEventBySubjectName,
  eventSlugsFromSubjectUrl,
  slugCandidatesFromSubject,
} from "../email-handlers/photo-intake.js";
import { attachGeneralPhotos, type GeneralPhoto, type GeneralPhotoEnv } from "./general-photos.js";

/** The held reply_kind we recover. */
const HELD_REPLY_KIND = "photo-intake-unresolved";

/** Image attachments of a held email as gallery-attach inputs. */
export function generalPhotosFromRefs(attachmentRefs: string | null): GeneralPhoto[] {
  return imageRefs(parseRefs(attachmentRefs)).map((r) => ({
    key: r.key,
    name: r.name,
    contentType: r.mimeType,
  }));
}

/** Pull every `<...>` Message-ID out of In-Reply-To + References. Kept verbatim
 *  (with angle brackets) because that's how `inbound_emails.message_id` stores
 *  them, so the two compare directly. */
export function parseThreadMessageIds(
  inReplyTo: string | null,
  references: string | null
): string[] {
  const out = new Set<string>();
  for (const header of [inReplyTo, references]) {
    if (!header) continue;
    for (const m of header.matchAll(/<[^<>\s]+>/g)) out.add(m[0]);
  }
  return [...out];
}

/**
 * Held `photo-intake-unresolved` parents this reply threads to: their
 * `message_id` appears in the reply's In-Reply-To/References chain, they're
 * still unresolved, and — belt-and-braces against a forged thread id — they're
 * from the same sender as the reply.
 */
export async function findHeldPhotoParents(
  db: Db,
  messageIds: string[],
  fromAddress: string
): Promise<InboundEmail[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .select()
    .from(inboundEmails)
    .where(
      and(
        inArray(inboundEmails.messageId, messageIds),
        eq(inboundEmails.replyKind, HELD_REPLY_KIND),
        isNull(inboundEmails.resultingEventId),
        eq(inboundEmails.fromAddress, fromAddress)
      )
    );
  return rows as InboundEmail[];
}

/**
 * Which fair the reply names — URL, slug, or the fair name in prose. Reuses the
 * OPE-254 Defect-1 subject helpers, applied to the reply's subject AND body
 * (John's replies were "The fair is the Waterford Worlds Fair" and a pasted
 * event URL). Returns null when nothing resolves — the caller then leaves the
 * reply to normal correction handling rather than guessing.
 */
export async function resolveTargetEventFromReply(
  db: Db,
  subject: string | null,
  bodyExcerpt: string | null
): Promise<{ id: string; name: string; slug: string } | null> {
  const scan = `${subject ?? ""}\n${bodyExcerpt ?? ""}`;
  const slugs = [...eventSlugsFromSubjectUrl(scan), ...slugCandidatesFromSubject(subject)];
  const byExact = await findOverrideEvent(db, slugs);
  if (byExact) return byExact;
  // Fair name in prose: try the subject, then the (bounded) body excerpt.
  return (
    (await findEventBySubjectName(db, subject)) ?? (await findEventBySubjectName(db, bodyExcerpt))
  );
}

export interface HeldPhotoResolveResult {
  attached: number;
  failed: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Attach one held email's photos to `eventId` as gallery candidates and mark it
 * resolved. Idempotent: an already-resolved row is skipped; a row with no
 * images (e.g. the attachment-decode-miss case) is skipped WITHOUT marking
 * resolved, so it stays visible for follow-up. Marks resolved only when at
 * least one photo attached — a total failure stays unresolved for retry.
 */
export async function resolveHeldPhotoEmail(
  env: GeneralPhotoEnv,
  db: Db,
  row: Pick<InboundEmail, "id" | "attachmentRefs" | "resultingEventId">,
  eventId: string
): Promise<HeldPhotoResolveResult> {
  if (row.resultingEventId) {
    return { attached: 0, failed: 0, skipped: true, reason: "already-resolved" };
  }
  const photos = generalPhotosFromRefs(row.attachmentRefs);
  if (photos.length === 0) {
    return { attached: 0, failed: 0, skipped: true, reason: "no-image-attachments" };
  }
  const res = await attachGeneralPhotos(env, eventId, photos);
  if (res.attached > 0) {
    await db
      .update(inboundEmails)
      .set({ resultingEventId: eventId })
      .where(eq(inboundEmails.id, row.id));
    return { attached: res.attached, failed: res.failed, skipped: false };
  }
  // Nothing attached — leave unresolved so it can be retried after the cause
  // (misconfigured bindings / missing R2 object / upload rejection) is fixed.
  return {
    attached: 0,
    failed: res.failed,
    skipped: false,
    reason: res.disabledReason ?? res.failures?.[0] ?? "attach-failed",
  };
}

export interface ReplyResolveOutcome {
  event: { id: string; name: string; slug: string };
  /** Held parents the reply threaded to. */
  parentCount: number;
  /** Parents we actually attached photos for (excludes already-resolved / empty). */
  resolvedParents: number;
  attached: number;
  failed: number;
}

/**
 * Defect 2 — resolve held photos from a threaded reply that names the fair.
 * Returns null (→ fall through to normal correction handling) when this isn't a
 * held-photo reply: not trusted+authenticated, not threaded to a held parent, or
 * the named fair doesn't resolve.
 */
export async function resolveHeldPhotosFromReply(
  env: GeneralPhotoEnv,
  db: Db,
  ctx: HandlerCtx,
  row: InboundEmail
): Promise<ReplyResolveOutcome | null> {
  // Writes downstream (event_photos) — trusted + authenticated only, same gate
  // as the auto-write eligibility on the main intake path.
  if (ctx.emailAuth !== "pass" || ctx.senderTrust !== "trusted") return null;

  const ids = parseThreadMessageIds(row.inReplyTo, row.emailReferences);
  const parents = await findHeldPhotoParents(db, ids, row.fromAddress);
  if (parents.length === 0) return null;

  const event = await resolveTargetEventFromReply(db, row.subject, row.bodyTextExcerpt);
  if (!event) return null;

  let attached = 0;
  let failed = 0;
  let resolvedParents = 0;
  for (const parent of parents) {
    const r = await resolveHeldPhotoEmail(env, db, parent, event.id);
    if (!r.skipped) {
      resolvedParents++;
      attached += r.attached;
      failed += r.failed;
    }
  }
  return { event, parentCount: parents.length, resolvedParents, attached, failed };
}
