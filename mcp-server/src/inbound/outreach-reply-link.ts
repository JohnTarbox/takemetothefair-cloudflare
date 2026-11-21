/**
 * OPE-384 stage 4 / OPE-1509 — link an inbound reply to the outreach ask it
 * answers. Shared by the `link_promoter_reply` tool (by hand, dry-run default)
 * and the inbound workflow (`promoter-outreach/link-reply`, apply, every
 * inbound), so the two can never disagree about what a reply is.
 *
 * ## The two-hop join
 *
 * `send_promoter_email` hands the message to the EMAIL_JOBS queue, so the
 * provider's Message-ID is not known when the attempt row is written —
 * `promoter_outreach_attempts.provider_message_id` is never populated. The id
 * appears later, in the queue consumer, on the `email_send_ledger` row
 * (`source = 'email:promoter-outreach'`). So threading resolves as: inbound
 * `In-Reply-To`/`References` -> ledger `provider_message_id` -> ledger
 * `recipient` -> the attempt whose `to_address` is that recipient. The decision
 * itself is the pure `linkPromoterReply` (packages/db-schema).
 *
 * ## Nothing here auto-confirms, sends, or writes an event
 *
 * A link marks the attempt `replied`. It does NOT touch the event and does NOT
 * mark `confirmed`: reading an organizer's prose and deciding what it commits
 * to is a judgement that writes a public date. An ambiguous reply is reported,
 * never resolved by picking the first candidate.
 *
 * ## Sibling rows (OPE-1509 item 5)
 *
 * One email can become several inbound rows (fan-out intents). Only `sent`
 * attempts are candidates, and the UPDATE re-checks `status = 'sent'` with
 * RETURNING, so the first sibling links and every later one finds the ask no
 * longer open: one link, one audit row, never a double count.
 */
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  inboundEmails,
  emailSendLedger,
  promoterOutreachAttempts,
  promoters,
  adminActions,
  linkPromoterReply,
  normalizeEmailAddress,
  assertOutreachTransition,
  type ReplyLinkCandidate,
  type PromoterOutreachStatus,
} from "../schema.js";
import { chunkIds } from "@takemetothefair/utils";
import type { Db } from "../db.js";

export const OUTREACH_SOURCE = "email:promoter-outreach";

/** Verdicts that link. Everything else is reported and left alone. */
const LINKING = new Set(["message_id", "address", "subject_domain"]);

/**
 * Message-IDs the provider assigned to each open ask, keyed by recipient.
 * Chunked at 80 — D1 caps a statement at 100 bind parameters.
 */
async function ledgerIdsByAddress(db: Db, addresses: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const chunk of chunkIds([...new Set(addresses)], 80)) {
    const rows = await db
      .select({
        recipient: emailSendLedger.recipient,
        providerMessageId: emailSendLedger.providerMessageId,
      })
      .from(emailSendLedger)
      .where(
        and(eq(emailSendLedger.source, OUTREACH_SOURCE), inArray(emailSendLedger.recipient, chunk))
      );
    for (const r of rows) {
      const key = normalizeEmailAddress(r.recipient);
      if (!key || !r.providerMessageId) continue;
      const list = out.get(key) ?? [];
      list.push(r.providerMessageId);
      out.set(key, list);
    }
  }
  return out;
}

export interface LinkOutreachRepliesResult {
  applied: boolean;
  open_attempts: number;
  inbounds_examined: number;
  linked: number;
  results: Array<Record<string, unknown>>;
  /** Every candidate lacked a ledger Message-ID, so the thread rule could not fire. */
  noProviderIds: boolean;
}

export async function linkOutreachReplies(
  db: Db,
  args: {
    inboundEmailId?: string;
    /** Operator override: resolves an `ambiguous` verdict by hand. */
    attemptId?: string;
    apply: boolean;
    limit?: number;
    actorUserId: string | null;
    /** Recorded on the audit row: `tool` or `capture`. */
    via: "tool" | "capture";
  }
): Promise<LinkOutreachRepliesResult> {
  // Open asks are the only ones a reply can answer. `replied` is excluded: it
  // already has an inbound, and a later message on the thread is a
  // continuation, not a new answer to find a home for.
  const openAttempts = await db
    .select({
      attemptId: promoterOutreachAttempts.id,
      eventId: promoterOutreachAttempts.eventId,
      promoterId: promoterOutreachAttempts.promoterId,
      toAddress: promoterOutreachAttempts.toAddress,
      subject: promoterOutreachAttempts.subject,
      sentAt: promoterOutreachAttempts.sentAt,
      status: promoterOutreachAttempts.status,
      promoterWebsite: promoters.website,
    })
    .from(promoterOutreachAttempts)
    .leftJoin(promoters, eq(promoters.id, promoterOutreachAttempts.promoterId))
    .where(eq(promoterOutreachAttempts.status, "sent"));

  const empty = (n: number): LinkOutreachRepliesResult => ({
    applied: args.apply,
    open_attempts: openAttempts.length,
    inbounds_examined: n,
    linked: 0,
    results: [],
    noProviderIds: false,
  });
  // The capture path runs on every inbound; with no open ask there is nothing
  // to read further.
  if (openAttempts.length === 0 && !args.attemptId) return empty(0);

  const ledger = await ledgerIdsByAddress(
    db,
    openAttempts.map((a) => a.toAddress)
  );
  const candidates: ReplyLinkCandidate[] = openAttempts.map((a) => ({
    attemptId: a.attemptId,
    eventId: a.eventId,
    toAddress: a.toAddress,
    sentAt: a.sentAt,
    subject: a.subject,
    promoterWebsite: a.promoterWebsite ?? null,
    providerMessageIds: ledger.get(normalizeEmailAddress(a.toAddress) ?? "") ?? [],
  }));

  const inbounds = await db
    .select({
      id: inboundEmails.id,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      receivedAt: inboundEmails.receivedAt,
      inReplyTo: inboundEmails.inReplyTo,
      emailReferences: inboundEmails.emailReferences,
    })
    .from(inboundEmails)
    .where(args.inboundEmailId ? eq(inboundEmails.id, args.inboundEmailId) : undefined)
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(args.inboundEmailId ? 1 : (args.limit ?? 25));

  const results: Array<Record<string, unknown>> = [];
  let linked = 0;

  for (const inb of inbounds) {
    const verdict = args.attemptId
      ? ({ match: "address", attemptId: args.attemptId } as const)
      : linkPromoterReply({
          inbound: {
            fromAddress: inb.fromAddress,
            subject: inb.subject,
            inReplyTo: inb.inReplyTo,
            emailReferences: inb.emailReferences,
            receivedAt: inb.receivedAt,
          },
          candidates,
        });

    const row: Record<string, unknown> = {
      inbound_email_id: inb.id,
      from: inb.fromAddress,
      subject: inb.subject,
      verdict: verdict.match,
      ...("attemptId" in verdict ? { attempt_id: verdict.attemptId } : {}),
      ...("attemptIds" in verdict ? { candidates: verdict.attemptIds } : {}),
      ...("reason" in verdict ? { reason: verdict.reason } : {}),
      ...("note" in verdict && verdict.note ? { note: verdict.note } : {}),
    };

    if (!LINKING.has(verdict.match) || !("attemptId" in verdict)) {
      results.push(row);
      continue;
    }

    const target = openAttempts.find((a) => a.attemptId === verdict.attemptId);
    if (!target) {
      results.push({ ...row, verdict: "none", reason: "attempt is not open" });
      continue;
    }

    // Enforced rather than assumed: the transition map decides what may follow
    // `sent`, and an operator override naming a closed attempt would otherwise
    // reopen it.
    try {
      assertOutreachTransition(target.status as PromoterOutreachStatus, "replied");
    } catch (e) {
      results.push({ ...row, verdict: "refused", reason: (e as Error).message });
      continue;
    }

    if (args.apply) {
      const now = new Date();
      // Re-checks `sent`: a sibling row of the same email may have linked it a
      // moment ago. RETURNING proves THIS call made the transition.
      const done = await db
        .update(promoterOutreachAttempts)
        .set({ status: "replied", outcomeAt: now, inboundEmailId: inb.id })
        .where(
          and(
            eq(promoterOutreachAttempts.id, target.attemptId),
            eq(promoterOutreachAttempts.status, "sent")
          )
        )
        .returning({ id: promoterOutreachAttempts.id });
      if (done.length === 0) {
        results.push({ ...row, verdict: "none", reason: "attempt was linked meanwhile" });
        continue;
      }
      target.status = "replied";

      await db.insert(adminActions).values({
        action: "promoter.outreach_replied",
        actorUserId: args.actorUserId,
        targetType: "promoter",
        targetId: target.promoterId,
        payloadJson: JSON.stringify({
          attemptId: target.attemptId,
          eventId: target.eventId,
          inboundEmailId: inb.id,
          matchedBy: verdict.match,
          overridden: !!args.attemptId,
          via: args.via,
        }),
        createdAt: now,
      });
    }
    linked++;
    results.push(row);
  }

  return {
    applied: args.apply,
    open_attempts: openAttempts.length,
    inbounds_examined: inbounds.length,
    linked,
    results,
    noProviderIds:
      inbounds.length > 0 &&
      candidates.length > 0 &&
      candidates.every((c) => (c.providerMessageIds?.length ?? 0) === 0),
  };
}
