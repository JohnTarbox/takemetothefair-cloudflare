/**
 * OPE-407 — content-free inbound mail: the email that arrived carrying nothing.
 *
 * 2026-08-15 23:22:38–23:23:26Z, six emails in 48 seconds, each with no
 * subject, no body and no attachment. They were six booth photos whose
 * attachment never left the phone. Each was classified `intent='submit'`, found
 * no URL, and was answered `no-url` — six polite dead ends, none of which gave
 * the sender any reason to suspect the photos had not arrived. The same
 * signature appears on 2026-07-17. Seven in one month, all silently absorbed.
 *
 * ── The discriminator is CONTENT-FREE, not attachment-free ─────────────────
 * The same sender's legitimate URL-less submissions carry 38–5,109 characters of
 * prose ("Lovell Old Home Days", the Piscataqua Riverfest forward) and must keep
 * their existing handling. Only a message with no attachment AND essentially no
 * body AND no usable subject is content-free. That is a much narrower claim than
 * "has no attachment", and it is the reason this can be an automatic reply at
 * all: there is nothing in such a message to misread.
 *
 * ── Why the reply is debounced rather than immediate ───────────────────────
 * The value here is latency — the sender is holding the phone that still has
 * the photos — but replying to the FIRST message of a burst means saying "one
 * email arrived empty" while five more are in flight, and replying to each means
 * six notices for one mistake. So the earliest message in the window waits a
 * short debounce, counts the burst, and sends exactly one notice; the rest are
 * recorded and suppressed. The wait is measured in seconds, not until tomorrow's
 * digest: a notice that arrives after the sender has put the phone down has lost
 * everything it was for.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { inboundEmails } from "../schema.js";
import type { Db } from "../db.js";

/**
 * Non-whitespace characters below which a body counts as absent.
 *
 * The observed rows carry a body of literally `"\n\n"` (2 chars, 0
 * non-whitespace). The nearest legitimate submission is 38 characters. Ten is
 * comfortably between them and would have to be wrong by nearly 4x to
 * misclassify a real message.
 */
export const EMPTY_BODY_MAX_CHARS = 10;

/** A subject shorter than this carries no usable signal. Gmail's "(no
 *  subject)" placeholder is not sent on the wire — these rows have none at
 *  all — but a stray "Fw:" or "photo" should not count as content either. */
export const EMPTY_SUBJECT_MAX_CHARS = 3;

/** Messages from one sender within this window are one failed batch send, not
 *  N separate mistakes. The observed burst spanned 48 seconds; 5 minutes covers
 *  a slow upload without merging two genuinely separate attempts. */
export const BURST_WINDOW_MS = 5 * 60 * 1000;

/** How long the burst leader waits before counting and replying. Long enough to
 *  cover the observed 48-second spread with margin, short enough that the reply
 *  lands while the sender is still at the phone. */
export const BURST_DEBOUNCE_SECONDS = 90;

/**
 * Above this raw MIME size, a message that PRESENTS as empty is more likely to
 * be something we failed to parse than something the sender failed to fill in.
 *
 * Measured across all 268 prod rows carrying a `raw_size` (2026-08-16):
 *
 *   messages WITH an attachment      min 19,864 B   (n=61)
 *   the seven content-free rows      ~7,084–7,108 B
 *
 * So 15 KB sits in open space between the two populations. The point is not to
 * fingerprint Gmail's headers — that would rot the moment Gmail changes them —
 * it is to refuse to make the claim at all when the message was demonstrably
 * carrying weight. Telling a sender "your email arrived with nothing in it"
 * when in fact we dropped 80 KB of their message on the floor is a worse
 * failure than the one this whole ticket is fixing, because it is confidently
 * wrong and it blames them for it.
 *
 * A NULL `raw_size` (older rows) does not block detection — absence of the
 * measurement is not evidence against it.
 */
export const EMPTY_RAW_SIZE_MAX_BYTES = 15_000;

export interface ContentFreeInput {
  /** Full body text, or the excerpt when the full column is null. */
  bodyText: string | null | undefined;
  subject: string | null | undefined;
  attachmentCount: number | null | undefined;
  /** Raw MIME size as received. Optional — see EMPTY_RAW_SIZE_MAX_BYTES. */
  rawSize?: number | null;
}

/**
 * True when a message carries no attachment, no meaningful body, and no
 * meaningful subject — and was not big enough to have been carrying something
 * we failed to read.
 */
export function isContentFreeEmail(input: ContentFreeInput): boolean {
  if ((input.attachmentCount ?? 0) > 0) return false;
  const bodyChars = (input.bodyText ?? "").replace(/\s/g, "").length;
  if (bodyChars > EMPTY_BODY_MAX_CHARS) return false;
  const subjectChars = (input.subject ?? "").replace(/\s/g, "").length;
  if (subjectChars > EMPTY_SUBJECT_MAX_CHARS) return false;
  if (input.rawSize != null && input.rawSize > EMPTY_RAW_SIZE_MAX_BYTES) return false;
  return true;
}

export interface BurstAssessment {
  /** True when this row is the earliest content-free message from this sender
   *  in the window — i.e. the one that will speak for the batch. */
  isLeader: boolean;
}

/**
 * Fetch every inbound row from this sender inside the burst window and keep the
 * content-free ones, judged from the columns written at RECEIVE time.
 *
 * The obvious query — "rows already marked `reply_kind='empty-message'`" — is
 * wrong, and wrong in the way that would have quietly produced six notices
 * anyway: `reply_kind` is written at `mark-done`, AFTER this runs. Six
 * concurrent workflows would each look for siblings, each find none marked yet,
 * and each elect itself leader. Judging from `attachment_count` / `subject` /
 * `body_text_excerpt` — all stamped before any workflow starts — means the
 * answer is already settled in the table and every worker computes the same one.
 *
 * The excerpt is sufficient and cheaper than the full body: it is
 * `body_text.slice(0, 500)`, so a body with substance cannot produce an empty
 * excerpt.
 */
async function contentFreeRowsInWindow(
  db: Db,
  row: { fromAddress: string; receivedAt: Date }
): Promise<Array<{ id: string; receivedAt: Date }>> {
  const rows = await db
    .select({
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      subject: inboundEmails.subject,
      bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
      attachmentCount: inboundEmails.attachmentCount,
      rawSize: inboundEmails.rawSize,
    })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.fromAddress, row.fromAddress),
        gte(inboundEmails.receivedAt, new Date(row.receivedAt.getTime() - BURST_WINDOW_MS)),
        lte(inboundEmails.receivedAt, new Date(row.receivedAt.getTime() + BURST_WINDOW_MS))
      )
    );
  return rows
    .filter((r) =>
      isContentFreeEmail({
        bodyText: r.bodyTextExcerpt,
        subject: r.subject,
        attachmentCount: r.attachmentCount,
        rawSize: r.rawSize,
      })
    )
    .map((r) => ({ id: r.id, receivedAt: r.receivedAt }));
}

/**
 * Decide whether this row leads its burst — i.e. whether it is the earliest
 * content-free message from this sender in the window, and so the one that
 * speaks for the batch.
 *
 * The tie-break on `id` matters only when two messages share a `received_at` to
 * the second (the observed burst was 8 seconds apart, but that is luck, not a
 * guarantee). Ordering on a non-unique column alone would let two rows both
 * believe they were earliest and send two notices.
 */
export async function assessContentFreeBurst(
  db: Db,
  row: { id: string; fromAddress: string; receivedAt: Date }
): Promise<BurstAssessment> {
  const siblings = await contentFreeRowsInWindow(db, row);
  const earlier = siblings.filter(
    (s) =>
      s.receivedAt.getTime() < row.receivedAt.getTime() ||
      (s.receivedAt.getTime() === row.receivedAt.getTime() && s.id < row.id)
  );
  return { isLeader: earlier.length === 0 };
}

/**
 * Count the content-free messages this burst ended up containing, including the
 * leader itself. Called after the debounce, so stragglers are included.
 */
export async function countContentFreeBurst(
  db: Db,
  row: { fromAddress: string; receivedAt: Date }
): Promise<number> {
  const siblings = await contentFreeRowsInWindow(db, row);
  // Never below 1: the leader's own row is in the burst by definition, and a
  // notice reading "0 emails arrived" would be nonsense.
  return Math.max(1, siblings.length);
}
