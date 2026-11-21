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
import { linkOutreachReplies, OUTREACH_SOURCE } from "../inbound/outreach-reply-link.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

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
      "Verdicts, strongest first: `message_id` (the reply threads to our send),",
      "`address` (from the address we wrote to), `subject_domain` (Re: our subject,",
      "from the organizer's own domain — never a mailbox provider's).",
      "",
      "The inbound workflow runs this with apply=true on every email (OPE-1509), so",
      "by hand it is for a dry-run look or an `ambiguous` override.",
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
      const r = await linkOutreachReplies(db, {
        inboundEmailId: inbound_email_id,
        attemptId: attempt_id,
        apply,
        limit,
        actorUserId: auth.userId,
        via: "tool",
      });
      if (inbound_email_id && r.inbounds_examined === 0 && r.open_attempts > 0) {
        return {
          content: [{ type: "text" as const, text: `No inbound email ${inbound_email_id}.` }],
        };
      }
      const { noProviderIds, ...out } = r;
      return {
        content: [
          jsonContent({
            ...out,
            next: "A linked ask is `replied`, not `confirmed`. Apply the answer with update_event + citation, then set_promoter_outreach_status(confirmed).",
            ...(noProviderIds
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
