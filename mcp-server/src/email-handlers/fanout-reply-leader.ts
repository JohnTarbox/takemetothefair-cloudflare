/**
 * OPE-720 — one reply per RECEIVED MESSAGE, not one per routed child.
 *
 * When the classifier detects more than one intent, `email-handler.ts` writes a
 * parent row (`intent='multi'`) plus one synthesized child per intent, and
 * starts an independent workflow for each child. Each child then composed and
 * sent its own acknowledgement, so a two-topic email drew two replies:
 * ewelford@paradisecityarts.com received two `correction-ack`s seconds apart on
 * 2026-08-17, for one message, while a human was mid-correspondence with her.
 *
 * The children are a ROUTING artefact. The person sent one email and should get
 * one answer. This module elects the child that speaks for the family.
 *
 * ## Why a rank table and not a lock
 *
 * The obvious fix — first child to reach the send site claims the family — gives
 * exactly one reply, but WHICH reply depends on how the Workflows runtime happens
 * to schedule N instances. The 2026-05-21 cluster shows why that is not good
 * enough: its children carried `correction-ack` and `ok-medium`, so a scheduling
 * coin-flip would decide whether the sender is told "we noted your correction" or
 * "we created your event". The choice must be named, not raced.
 *
 * So the winner is derived from `intent` and `id` — both stamped at INSERT time,
 * before any workflow starts. Every sibling reads the same settled table and
 * computes the same answer with no coordination, exactly as
 * `assessContentFreeBurst` does for a burst (and for the same reason: judging
 * from a column written later would let every worker elect itself).
 *
 * ## Why the losers are not silenced
 *
 * A losing child still runs its handler — the unsubscribe still flips the row,
 * the claim is still recorded. Only the outbound reply is suppressed, and its
 * `reply_kind` is preserved so it stays countable, mirroring OPE-407's
 * burst-follower convention. And the leader's reply NAMES the other topics
 * (`fanoutOtherIntents`), so the one message the sender receives is correct for
 * the whole email rather than answering a third of it.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { inboundEmails } from "../schema.js";
import type { EmailIntent } from "../email-intents.js";
import type { Db } from "../db.js";

/**
 * Which child speaks for the family, ordered by how much its reply tells the
 * sender that they could not otherwise infer. Higher wins.
 *
 * The ordering is a judgement, and these are the reasons for it:
 *
 * - `unsubscribe` outranks everything. It confirms a consent change we made to
 *   their record. Answering an unsubscribe with "we created your event" and
 *   never confirming the opt-out is the one substitution with a compliance edge.
 * - Then the intents that report a CONCRETE state change (`new_event`/`submit`,
 *   `correction`, `claim_request`) — the sender learns an outcome.
 * - Then the intents whose reply is an acknowledgement of receipt
 *   (`vendor_inquiry`, `source_suggestion`, `press`, `support`).
 * - `unclear` and `unknown` sit at the bottom: they route to admin triage, and
 *   `unknown` does not reply at all.
 * - `spam` is last and never replies (the spam handler returns `replyKind: null`).
 *
 * `multi` is the parent's own value and never appears on a child; it is listed
 * so the table is total over `EmailIntent` and a new intent cannot be added
 * without landing here.
 */
export const FANOUT_REPLY_RANK: Record<EmailIntent, number> = {
  unsubscribe: 100,
  // Opt-in is the same kind of fact as opt-out — a change to their consent
  // record — and ranks just under it: failing to confirm a subscription is a
  // disappointment, failing to confirm an unsubscribe is a complaint.
  newsletter_subscribe: 95,
  new_event: 90,
  submit: 90,
  correction: 80,
  // A problem report is a correction aimed at the site rather than a listing,
  // and its reply carries the same kind of news: we opened a report.
  problem_report: 75,
  claim_request: 70,
  // Photos actually landed somewhere — a countable outcome, above the
  // acknowledgement-only intents below.
  photo_intake: 65,
  vendor_inquiry: 60,
  source_suggestion: 50,
  press: 40,
  support: 30,
  unclear: 20,
  unknown: 10,
  spam: 0,
  multi: 0,
};

export interface FanoutSibling {
  id: string;
  intent: EmailIntent;
}

export interface FanoutReplyRole {
  /** True when this row is the one child that sends the family's reply. */
  isLeader: boolean;
  /** The OTHER children's intents — what else the sender's message covered. */
  otherIntents: EmailIntent[];
}

/**
 * Pick the family's spokesperson: highest `FANOUT_REPLY_RANK`, ties broken by
 * the lexicographically smallest `id`.
 *
 * The tie-break is not decorative. Nothing in `resolveRouting` guarantees the
 * classifier returns DISTINCT intents for the children it splits out — it maps
 * `result.intents` one-to-one and only filters on confidence. Two children with
 * the same intent would both out-rank nobody and both elect themselves, which is
 * the exact defect this module exists to remove. `id` is a UUID assigned at
 * insert and is unique by construction, so the tie always resolves to one row.
 */
export function pickFanoutReplyLeader(siblings: FanoutSibling[]): string | null {
  let best: FanoutSibling | null = null;
  for (const s of siblings) {
    if (best === null) {
      best = s;
      continue;
    }
    const rank = FANOUT_REPLY_RANK[s.intent] ?? 0;
    const bestRank = FANOUT_REPLY_RANK[best.intent] ?? 0;
    if (rank > bestRank || (rank === bestRank && s.id < best.id)) best = s;
  }
  return best?.id ?? null;
}

/**
 * Resolve this row's role in its fan-out family.
 *
 * Returns `null` for a row that is not part of a fan-out — the overwhelmingly
 * common case (4 rows of 420 carried a `parent_email_id` when this was filed).
 * The caller treats `null` as "behave exactly as before", so the single-intent
 * path is untouched.
 */
export async function resolveFanoutReplyRole(
  db: Db,
  rowId: string
): Promise<FanoutReplyRole | null> {
  const self = await db
    .select({ parentEmailId: inboundEmails.parentEmailId })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, rowId))
    .limit(1);
  const parentId = self[0]?.parentEmailId ?? null;
  if (!parentId) return null;

  const siblings = await db
    .select({ id: inboundEmails.id, intent: inboundEmails.intent })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.parentEmailId, parentId), isNotNull(inboundEmails.parentEmailId)));

  // A family of one is not a fan-out. Can happen if a sibling INSERT aborted
  // mid-family; the survivor should still answer rather than fall silent.
  if (siblings.length <= 1) return null;

  const leaderId = pickFanoutReplyLeader(siblings as FanoutSibling[]);
  return {
    isLeader: leaderId === rowId,
    otherIntents: siblings.filter((s) => s.id !== leaderId).map((s) => s.intent as EmailIntent),
  };
}
