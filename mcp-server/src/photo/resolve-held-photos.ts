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

import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { recordCrossing, ref } from "../inbound/crossing-ledger.js";
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
 * OPE-403 — photo intakes that ran the attach path and stored nothing.
 *
 * The blind spot this closes: these rows are `reply_kind='photo-intake-ack'`,
 * `status='replied'`, with `resulting_event_id` set. Every existing queue reads
 * that as finished. They are not — the photos are nowhere.
 *
 * Selects on `photos_stored = 0` rather than on a reply_kind, deliberately: the
 * defect is defined by what was STORED, and keying on reply_kind would miss the
 * next variant of it the same way this one was missed. Rows with `photos_stored`
 * NULL are excluded — NULL is "the attach path never ran here", which is true of
 * every non-photo email in the table.
 *
 * These already know their event, so draining one is a re-attach, not a
 * re-identify — pass `row.resultingEventId` straight to `resolveHeldPhotoEmail`.
 */
export async function findUnstoredPhotoIntakes(db: Db, limit = 50): Promise<InboundEmail[]> {
  const rows = await db
    .select()
    .from(inboundEmails)
    .where(and(eq(inboundEmails.photosStored, 0), isNotNull(inboundEmails.resultingEventId)))
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(limit);
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

/**
 * OPE-403 — has this email's photos ALREADY been attached?
 *
 * This used to be `Boolean(row.resultingEventId)`, which is not that question.
 * `resulting_event_id` records which fair we DECIDED the photos are from; the
 * matcher sets it whether or not a single byte reached `event_photos`. So every
 * acked-but-unstored row read as "already resolved" and a rescue run would have
 * skipped exactly the rows it was needed for.
 *
 * Migration-aware on purpose, and this is the part that must not be simplified:
 *
 *   photos_stored NOT NULL → authoritative. 0 means tried-and-stored-nothing,
 *                            which is precisely a row we SHOULD attach.
 *   photos_stored IS NULL  → pre-OPE-403 row. We have no count, so fall back to
 *                            the legacy proxy.
 *
 * Dropping that fallback and testing `photosStored > 0` alone would treat every
 * historical successfully-resolved row (count NULL, event set) as unattached and
 * re-attach its photos — and `attachGeneralPhotos` is NOT dedup'd, so that
 * duplicates gallery rows. The NULL branch is a correctness guard, not legacy
 * politeness.
 */
export function alreadyAttached(
  row: Pick<InboundEmail, "resultingEventId" | "photosStored">
): boolean {
  return row.photosStored != null ? row.photosStored > 0 : Boolean(row.resultingEventId);
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
  row: Pick<InboundEmail, "id" | "attachmentRefs" | "resultingEventId" | "photosStored">,
  eventId: string
): Promise<HeldPhotoResolveResult> {
  if (alreadyAttached(row)) {
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
      .set({
        resultingEventId: eventId,
        // OPE-403 — record the COUNT, not just the decision. This is what makes
        // a later run's skip decision a fact rather than an inference.
        photosStored: res.attached,
        // OPE-551 — leave the row's STATE honest, not just its data.
        //
        // This wrote resulting_event_id and photos_stored and left
        // `status='failed'` in place, so an email whose photo had just been
        // delivered still counted as stuck. The daily exception rail
        // (`reconcileInboundExceptions`, "already-handled: failed but has a
        // resulting event → salvaged") does eventually correct it — so the
        // report of a PERMANENT wrong number was not right — but "eventually"
        // is up to 24 hours, and for that whole window the purpose-built
        // recovery tool leaves the ledger contradicting itself.
        //
        // Guarded by a CASE rather than set unconditionally: this function also
        // runs on rows that never failed (a photo held only because the event
        // was ambiguous), and stamping `salvaged` over `processed` or `replied`
        // would be a different lie in the other direction. SQLite evaluates all
        // SET expressions against the pre-update row, so this reads the old
        // status correctly.
        status: sql`CASE WHEN ${inboundEmails.status} = 'failed' THEN 'salvaged' ELSE ${inboundEmails.status} END`,
      })
      .where(eq(inboundEmails.id, row.id));
    return { attached: res.attached, failed: res.failed, skipped: false };
  }
  // OPE-403 — the attach path ran and stored nothing. Record the 0 so the
  // reconciliation sweep can see it; leaving it NULL would read as "never
  // tried" and hide a row that genuinely needs another pass.
  await db
    .update(inboundEmails)
    .set({ photosStored: 0, flaggedForReview: 1 })
    .where(eq(inboundEmails.id, row.id));
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
      // OPE-330 (D-4) — close the membrane. The held row recorded an
      // email_to_hold crossing with a NULL destination; this is the matching
      // exit, so the probe stops counting it as work stopped at a boundary.
      // OPE-254's nine stranded photos are the reason this pair exists.
      await recordCrossing(db, {
        sourceRef: ref.inboundEmail(parent.id),
        destinationRef: ref.event(event.id),
        crossingType: "hold_to_resolve",
        // A human named the fair in a reply; the system only carried it out.
        actor: "human",
        notes: `attached=${r.attached} failed=${r.failed}`,
      });
    }
  }
  return { event, parentCount: parents.length, resolvedParents, attached, failed };
}
