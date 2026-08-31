/**
 * OPE-384 stage 4 — closing the loop: which ask did this reply answer?
 *
 * Stage 3 gave an attempt a way out of `sent` by timing out. This gives it the
 * way out we actually want: the organizer wrote back.
 *
 * ## The two-hop join, and why the obvious one-hop version does not exist
 *
 * `send_promoter_email` hands the message to the EMAIL_JOBS queue, so the
 * provider's Message-ID is not known when the attempt row is written —
 * `promoter_outreach_attempts.provider_message_id` is never populated by
 * anyone. The id appears later, in the queue consumer, on the
 * `email_send_ledger` row (`source = 'email:promoter-outreach'`).
 *
 * So threading resolves as: inbound `In-Reply-To`/`References` -> ledger
 * `provider_message_id` -> ledger `recipient` -> the attempt whose
 * `to_address` is that recipient. This file does the hops; the decision itself
 * lives in the pure `linkPromoterReply`, which is where it can be tested
 * against a wrong-link scenario rather than hoped about.
 *
 * ## Nothing here auto-confirms
 *
 * A link marks the attempt `replied`. It does NOT touch the event's dates, and
 * it does NOT mark `confirmed`. Reading an organizer's prose and deciding it
 * says "yes, September 11-12" is a judgement, and one that writes a public
 * date; it stays with `update_event` + a citation and an explicit
 * `set_promoter_outreach_status(confirmed)`. An ambiguous reply is reported as
 * ambiguous rather than resolved by picking the first candidate.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  inboundEmails,
  emailSendLedger,
  promoterOutreachAttempts,
  adminActions,
  linkPromoterReply,
  normalizeEmailAddress,
  assertOutreachTransition,
  type ReplyLinkCandidate,
  type PromoterOutreachStatus,
} from "../schema.js";
import { chunkIds } from "@takemetothefair/utils";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const OUTREACH_SOURCE = "email:promoter-outreach";

/**
 * Message-IDs the provider assigned to each open ask, keyed by attempt.
 *
 * The ledger has no attempt id, so the join is on `recipient` within the
 * outreach source. Chunked at 80 — D1 caps a statement at 100 bind parameters,
 * and stage 2 learned that on its first prod call rather than in review.
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

export function registerPromoterReplyIngestTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "link_promoter_reply",
    [
      "OPE-384 stage 4 — attach an inbound reply to the outreach ask it answers.",
      "",
      "Marks the attempt `replied` and records the inbound id. It does NOT change",
      "the event's dates and does NOT mark `confirmed`: reading an organizer's",
      "prose and deciding what it commits to is a judgement that writes a public",
      "date, so it stays with update_event + a citation.",
      "",
      "Ambiguity is reported, never resolved by picking the first candidate — a",
      "wrong link marks an ask answered and lets its event leave the queue",
      "carrying somebody else's answer.",
      "",
      "DRY RUN by default: pass apply=true to write. Admin only.",
    ].join("\n"),
    {
      inbound_email_id: z
        .string()
        .optional()
        .describe("Link one specific inbound. Omit to scan recent unlinked inbounds."),
      attempt_id: z
        .string()
        .optional()
        .describe("Override the match — use to resolve an `ambiguous` verdict by hand."),
      apply: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ inbound_email_id, attempt_id, apply, limit }) => {
      // Open asks are the only ones a reply can answer. `replied` is excluded:
      // it already has an inbound, and a second message on the same thread is
      // a continuation, not a new answer to find a home for.
      const openAttempts = await db
        .select({
          attemptId: promoterOutreachAttempts.id,
          eventId: promoterOutreachAttempts.eventId,
          promoterId: promoterOutreachAttempts.promoterId,
          toAddress: promoterOutreachAttempts.toAddress,
          sentAt: promoterOutreachAttempts.sentAt,
          status: promoterOutreachAttempts.status,
        })
        .from(promoterOutreachAttempts)
        .where(eq(promoterOutreachAttempts.status, "sent"));

      const ledger = await ledgerIdsByAddress(
        db,
        openAttempts.map((a) => a.toAddress)
      );
      const candidates: ReplyLinkCandidate[] = openAttempts.map((a) => ({
        attemptId: a.attemptId,
        eventId: a.eventId,
        toAddress: a.toAddress,
        sentAt: a.sentAt,
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
        .where(inbound_email_id ? eq(inboundEmails.id, inbound_email_id) : undefined)
        .orderBy(desc(inboundEmails.receivedAt))
        .limit(inbound_email_id ? 1 : limit);

      if (inbound_email_id && inbounds.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No inbound email ${inbound_email_id}.` }],
        };
      }

      const results: Array<Record<string, unknown>> = [];
      let linked = 0;

      for (const inb of inbounds) {
        const verdict = attempt_id
          ? ({ match: "address", attemptId: attempt_id } as const)
          : linkPromoterReply({
              inbound: {
                fromAddress: inb.fromAddress,
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

        if (verdict.match !== "message_id" && verdict.match !== "address") {
          results.push(row);
          continue;
        }

        const target = openAttempts.find((a) => a.attemptId === verdict.attemptId);
        if (!target) {
          results.push({ ...row, verdict: "none", reason: "attempt is not open" });
          continue;
        }

        // Enforced rather than assumed: the transition map is the one place
        // that decides what may follow `sent`, and an operator override that
        // named a closed attempt would otherwise reopen it.
        try {
          assertOutreachTransition(target.status as PromoterOutreachStatus, "replied");
        } catch (e) {
          results.push({ ...row, verdict: "refused", reason: (e as Error).message });
          continue;
        }

        if (apply) {
          const now = new Date();
          await db
            .update(promoterOutreachAttempts)
            .set({ status: "replied", outcomeAt: now, inboundEmailId: inb.id })
            .where(eq(promoterOutreachAttempts.id, target.attemptId));

          await db.insert(adminActions).values({
            action: "promoter.outreach_replied",
            actorUserId: auth.userId,
            targetType: "promoter",
            targetId: target.promoterId,
            payloadJson: JSON.stringify({
              attemptId: target.attemptId,
              eventId: target.eventId,
              inboundEmailId: inb.id,
              matchedBy: verdict.match,
              overridden: !!attempt_id,
            }),
            createdAt: now,
          });
        }
        linked++;
        results.push(row);
      }

      return {
        content: [
          jsonContent({
            applied: apply,
            open_attempts: openAttempts.length,
            inbounds_examined: inbounds.length,
            linked,
            results,
            next: "A linked ask is `replied`, not `confirmed`. Apply the answer with update_event + citation, then set_promoter_outreach_status(confirmed).",
            ...(inbounds.length > 0 && candidates.every((c) => c.providerMessageIds?.length === 0)
              ? {
                  warning:
                    "No provider Message-IDs found for any open ask, so only the address rule can fire. " +
                    `Expected email_send_ledger rows with source='${OUTREACH_SOURCE}'.`,
                }
              : {}),
          }),
        ],
      };
    }
  );
}
