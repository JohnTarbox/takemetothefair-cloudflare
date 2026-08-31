/**
 * OPE-384 stage 3 — the exit from `sent`.
 *
 * Before this file, `queued -> sent` was the only status write in the repo. An
 * organizer who never replied left their attempt in `sent` forever, and the
 * partial unique index on `(event_id) WHERE status IN ('queued','sent')` then
 * kept that event out of the queue permanently. Ask once, get silence, and the
 * event is locked out — by the same index that stops us pestering people.
 *
 * Two tools:
 *  - `sweep_promoter_outreach_timeouts` — closes silent asks and drafts the one
 *    permitted follow-up. DRY RUN unless `apply: true`.
 *  - `set_promoter_outreach_status` — the operator's hand on a single attempt,
 *    with the transition map enforced.
 *
 * Neither sends mail. A follow-up is written as `queued`, which is exactly what
 * `send_promoter_email` produces under a closed gate, and it goes out only if
 * and when somebody sends it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  promoters,
  promoterOutreachAttempts,
  adminActions,
  evaluateOutreachTimeout,
  assertOutreachTransition,
  buildFollowUpDraft,
  NO_RESPONSE_TIMEOUT_DAYS,
  type PromoterOutreachStatus,
} from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerPromoterOutreachLifecycleTools(
  server: McpServer,
  db: Db,
  auth: AuthContext
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "sweep_promoter_outreach_timeouts",
    [
      "OPE-384 stage 3 — close asks the organizer never answered, and draft the",
      "one permitted follow-up.",
      "",
      "Without this, a `sent` attempt never leaves `sent`, and the partial unique",
      "index that prevents double-asking then suppresses that event from the queue",
      "FOREVER. One ask, silence, gone.",
      "",
      "DRY RUN by default: pass apply=true to write. Never sends mail — a follow-up",
      "is written as `queued`, the same state a gated send produces.",
      "Admin only.",
    ].join("\n"),
    {
      apply: z
        .boolean()
        .default(false)
        .describe("false (default) reports what would change; true writes it."),
      timeout_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(`Days of silence before an ask is closed. Default ${NO_RESPONSE_TIMEOUT_DAYS}.`),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ apply, timeout_days, limit }) => {
      const now = new Date();

      const open = await db
        .select({
          id: promoterOutreachAttempts.id,
          promoterId: promoterOutreachAttempts.promoterId,
          eventId: promoterOutreachAttempts.eventId,
          subject: promoterOutreachAttempts.subject,
          sentAt: promoterOutreachAttempts.sentAt,
          followUpOf: promoterOutreachAttempts.followUpOf,
          reason: promoterOutreachAttempts.reason,
          promoterName: promoters.companyName,
          contactEmail: promoters.contactEmail,
        })
        .from(promoterOutreachAttempts)
        .leftJoin(promoters, eq(promoters.id, promoterOutreachAttempts.promoterId))
        .where(
          and(
            eq(promoterOutreachAttempts.status, "sent"),
            isNotNull(promoterOutreachAttempts.sentAt)
          )
        )
        .limit(limit);

      const expired: Array<Record<string, unknown>> = [];
      let followUpsDrafted = 0;
      let followUpsSkippedNoEmail = 0;

      for (const a of open) {
        const verdict = evaluateOutreachTimeout({
          status: "sent",
          sentAt: a.sentAt,
          followUpOf: a.followUpOf,
          now,
          timeoutDays: timeout_days,
        });
        if (verdict.action !== "expire") continue;

        // The follow-up goes to the promoter's CURRENT address, not the one we
        // used before. If enrichment has since corrected a typo, the second ask
        // should benefit from it; if the contact has been cleared, there is
        // nobody to write to and the honest outcome is no follow-up at all
        // rather than a draft addressed to nothing.
        const email = a.contactEmail?.trim();
        const wantsFollowUp = verdict.followUp && !!email && !!a.sentAt;

        expired.push({
          attempt_id: a.id,
          event_id: a.eventId,
          promoter: a.promoterName,
          days_silent: Number(verdict.daysSilent.toFixed(1)),
          follow_up: !verdict.followUp
            ? "no — this attempt is already the follow-up"
            : wantsFollowUp
              ? "drafted"
              : "no — promoter has no contact email; route to enrichment",
        });
        if (verdict.followUp && !wantsFollowUp) followUpsSkippedNoEmail++;

        if (!apply) {
          if (wantsFollowUp) followUpsDrafted++;
          continue;
        }

        // ORDER IS LOAD-BEARING, and the database enforces it. The partial
        // unique index covers `queued` AND `sent` together, so inserting the
        // follow-up while the original still reads `sent` violates it. Close
        // the original first; only then does the event have room for a second
        // ask.
        await db
          .update(promoterOutreachAttempts)
          .set({ status: "no_response", outcomeAt: now })
          .where(eq(promoterOutreachAttempts.id, a.id));

        if (wantsFollowUp && a.sentAt && email) {
          const draft = buildFollowUpDraft({
            eventName: a.subject.replace(/^Confirming this year's dates for /, ""),
            originalSubject: a.subject,
            originalSentAt: a.sentAt,
          });
          await db.insert(promoterOutreachAttempts).values({
            promoterId: a.promoterId,
            eventId: a.eventId,
            channel: "email",
            toAddress: email,
            subject: draft.subject,
            bodyText: draft.body,
            reason: a.reason,
            status: "queued",
            requestedBy: auth.userId ?? null,
            createdAt: now,
            followUpOf: a.id,
          });
          followUpsDrafted++;
        }

        await db.insert(adminActions).values({
          action: "promoter.outreach_timeout",
          actorUserId: auth.userId,
          targetType: "promoter",
          targetId: a.promoterId,
          payloadJson: JSON.stringify({
            attemptId: a.id,
            eventId: a.eventId,
            daysSilent: verdict.daysSilent,
            followUpDrafted: wantsFollowUp,
          }),
          createdAt: now,
        });
      }

      return {
        content: [
          jsonContent({
            applied: apply,
            scanned: open.length,
            expired: expired.length,
            follow_ups_drafted: followUpsDrafted,
            follow_ups_blocked_on_enrichment: followUpsSkippedNoEmail,
            timeout_days: timeout_days ?? NO_RESPONSE_TIMEOUT_DAYS,
            attempts: expired,
            note: apply
              ? "Follow-ups are queued, not sent. Nothing left the building."
              : "Dry run — nothing written. Pass apply=true to close these.",
          }),
        ],
      };
    }
  );

  server.tool(
    "set_promoter_outreach_status",
    [
      "OPE-384 stage 3 — move one outreach attempt, with the transition map enforced.",
      "",
      "Backwards moves are refused. `queued` and `sent` are the two statuses the",
      "partial unique index treats as OPEN, so reopening a closed attempt would",
      "re-suppress its event from the confirmation queue.",
      "`bounced` is terminal: a working address is a NEW attempt, not this row",
      "rewritten to claim we wrote somewhere we did not.",
      "Admin only.",
    ].join("\n"),
    {
      attempt_id: z.string().min(1),
      status: z.enum(["sent", "replied", "confirmed", "no_response", "bounced", "refused"]),
      inbound_email_id: z
        .string()
        .optional()
        .describe("The inbound that closed it, when moving to replied/confirmed."),
    },
    async ({ attempt_id, status, inbound_email_id }) => {
      const [row] = await db
        .select({
          id: promoterOutreachAttempts.id,
          status: promoterOutreachAttempts.status,
          promoterId: promoterOutreachAttempts.promoterId,
          eventId: promoterOutreachAttempts.eventId,
        })
        .from(promoterOutreachAttempts)
        .where(eq(promoterOutreachAttempts.id, attempt_id))
        .limit(1);

      if (!row) {
        return { content: [{ type: "text" as const, text: `No outreach attempt ${attempt_id}.` }] };
      }

      try {
        assertOutreachTransition(row.status as PromoterOutreachStatus, status);
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: (e as Error).message }],
        };
      }

      const now = new Date();
      await db
        .update(promoterOutreachAttempts)
        .set({
          status,
          outcomeAt: now,
          ...(inbound_email_id ? { inboundEmailId: inbound_email_id } : {}),
          ...(status === "sent" ? { sentAt: now } : {}),
        })
        .where(eq(promoterOutreachAttempts.id, attempt_id));

      await db.insert(adminActions).values({
        action: "promoter.outreach_status",
        actorUserId: auth.userId,
        targetType: "promoter",
        targetId: row.promoterId,
        payloadJson: JSON.stringify({
          attemptId: attempt_id,
          from: row.status,
          to: status,
          eventId: row.eventId,
          inboundEmailId: inbound_email_id ?? null,
        }),
        createdAt: now,
      });

      return {
        content: [jsonContent({ success: true, attempt_id, from: row.status, to: status })],
      };
    }
  );
}
