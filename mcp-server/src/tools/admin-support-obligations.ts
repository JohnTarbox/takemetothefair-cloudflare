/**
 * OPE-365 (R1) — the drain surface for support obligations.
 *
 * The ticket is explicit that a record without a resolution path is a flag, not
 * a queue: `inbound_exceptions` has sat at depth 33 with outflow_1d=0 and
 * drain_ratio_7d=0 precisely because `flagged_for_review` has nowhere to be
 * closed. Shipping the table without these tools would reproduce that exactly,
 * one table over.
 *
 * `not_an_obligation` is a first-class outcome, not a synonym for done. The SEO
 * outreach that shares Katie's `support` classification closes that way, and
 * the two counts stay separable — so "we answered everyone" and "we ignored
 * everyone" can never look alike in the inventory.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { supportObligations, SUPPORT_OBLIGATION_STATUS, inboundEmails } from "../schema.js";
import { decideObligation, extractEmailAddress } from "@takemetothefair/utils";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerSupportObligationTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_support_obligations",
    [
      "OPE-365 — people who emailed support/hello and are owed a human response.",
      "",
      "One row per inbound classified as ack-terminating (support / vendor_inquiry /",
      "unclear) from a real human sender, opened REGARDLESS of classifier confidence.",
      "That is the fix: the old signal (flagged_for_review) keyed off classifier",
      "UNCERTAINTY, so a clear, well-written bug report scored high and was never seen",
      "by anyone, while low-scoring SEO spam was flagged for human attention.",
      "",
      "Expect cold outreach in here too — nothing in the classified row distinguishes it",
      "from a real customer. Close those as not_an_obligation; it takes seconds and keeps",
      "the two countable apart. Admin only.",
    ].join(" "),
    {
      status: z
        .enum(["open", "answered", "not_an_obligation", "duplicate", "all"])
        .optional()
        .default("open"),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ status, limit }) => {
      const rows = await db
        .select()
        .from(supportObligations)
        .where(status === "all" ? undefined : eq(supportObligations.status, status))
        .orderBy(asc(supportObligations.openedAt))
        .limit(limit);

      const [oldest] = await db
        .select({ openedAt: supportObligations.openedAt })
        .from(supportObligations)
        .where(eq(supportObligations.status, SUPPORT_OBLIGATION_STATUS.OPEN))
        .orderBy(asc(supportObligations.openedAt))
        .limit(1);

      return {
        content: [
          jsonContent({
            count: rows.length,
            oldestOpenAt: oldest?.openedAt ?? null,
            oldestOpenAgeHours: oldest?.openedAt
              ? Math.floor((Date.now() - oldest.openedAt.getTime()) / 3_600_000)
              : null,
            obligations: rows,
          }),
        ],
      };
    }
  );

  server.tool(
    "resolve_support_obligation",
    [
      "OPE-365 — close a support obligation.",
      "",
      "answered = a human replied and the obligation is discharged.",
      "not_an_obligation = cold outreach/spam; no reply was owed.",
      "duplicate = same person and thread, tracked on another row.",
      "",
      "These stay distinct deliberately. Collapsing them into 'closed' makes a drained",
      "queue and an ignored queue look identical, which is the failure already sitting in",
      "inbound_exceptions. Admin only.",
    ].join(" "),
    {
      id: z.string().min(8).describe("Obligation id from list_support_obligations."),
      status: z.enum(["answered", "not_an_obligation", "duplicate"]),
      note: z.string().max(1000).optional().describe("Recorded on the row."),
    },
    async ({ id, status, note }) => {
      const [row] = await db
        .select({ id: supportObligations.id, status: supportObligations.status })
        .from(supportObligations)
        .where(eq(supportObligations.id, id))
        .limit(1);

      if (!row) {
        return { content: [jsonContent({ ok: false, error: "not_found", id })], isError: true };
      }
      if (row.status !== SUPPORT_OBLIGATION_STATUS.OPEN) {
        return {
          content: [
            jsonContent({
              ok: false,
              error: "already_closed",
              id,
              status: row.status,
              message: `Already '${row.status}'. Re-closing would overwrite who closed it and when.`,
            }),
          ],
          isError: true,
        };
      }

      await db
        .update(supportObligations)
        .set({
          status,
          closedAt: new Date(),
          closedBy: auth.userId ?? "admin",
          closeNote: note ?? null,
        })
        .where(
          and(
            eq(supportObligations.id, id),
            // Concurrency guard: only close a row that is still open.
            eq(supportObligations.status, SUPPORT_OBLIGATION_STATUS.OPEN)
          )
        );

      const [{ remaining } = { remaining: 0 }] = await db
        .select({ remaining: supportObligations.id })
        .from(supportObligations)
        .where(isNull(supportObligations.closedAt))
        .limit(1)
        .then((r) => [{ remaining: r.length }]);

      return {
        content: [jsonContent({ ok: true, id, status, moreOpen: remaining > 0 })],
      };
    }
  );

  server.tool(
    "backfill_support_obligations",
    [
      "OPE-365 — open obligations for support emails received BEFORE this shipped.",
      "",
      "Backfill rather than forward-only, deliberately: the premise of this ticket is that",
      "outstanding obligations are invisible. A queue that starts empty would report",
      "health on day one while the people already waiting stayed unrecorded — the same",
      "false-clean reading the ticket was filed about.",
      "",
      "Idempotent: support_obligations.inbound_email_id is UNIQUE and inserts use",
      "onConflictDoNothing, so re-running adds nothing. Applies the SAME decideObligation",
      "function the live handler uses — a backfill that restates the rule in SQL is how",
      "the two drift. Defaults to dry_run. Admin only.",
    ].join(" "),
    {
      since: z
        .string()
        .optional()
        .describe(
          "ISO date lower bound on received_at. Default 2026-07-09 (the OPE-353 census start)."
        ),
      dry_run: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(500).optional().default(200),
    },
    async ({ since, dry_run, limit }) => {
      const sinceDate = new Date(since ?? "2026-07-09T00:00:00Z");
      if (Number.isNaN(sinceDate.getTime())) {
        return {
          content: [jsonContent({ ok: false, error: "since is not a valid date" })],
          isError: true,
        };
      }

      const rows = await db
        .select({
          id: inboundEmails.id,
          fromAddress: inboundEmails.fromAddress,
          toAddress: inboundEmails.toAddress,
          subject: inboundEmails.subject,
          intent: inboundEmails.classifiedIntent,
          confidence: inboundEmails.classifiedConfidence,
          receivedAt: inboundEmails.receivedAt,
        })
        .from(inboundEmails)
        .where(gte(inboundEmails.receivedAt, sinceDate))
        .orderBy(asc(inboundEmails.receivedAt))
        .limit(limit);

      const eligible = rows.filter(
        (r) =>
          decideObligation({
            fromAddress: r.fromAddress ?? "",
            toAddress: r.toAddress,
            classifiedIntent: r.intent,
            classifiedConfidence: r.confidence,
            // Suppression is not re-checked here: an unsubscribe after the fact
            // does not retroactively erase that we owed them a reply at the time.
            suppressed: false,
          }).obligated
      );

      if (dry_run) {
        return {
          content: [
            jsonContent({
              ok: true,
              dryRun: true,
              scanned: rows.length,
              wouldOpen: eligible.length,
              sample: eligible.slice(0, 10).map((r) => ({
                inboundEmailId: r.id,
                from: extractEmailAddress(r.fromAddress ?? ""),
                confidence: r.confidence,
                subject: r.subject,
              })),
            }),
          ],
        };
      }

      let opened = 0;
      for (const r of eligible) {
        const res = await db
          .insert(supportObligations)
          .values({
            id: crypto.randomUUID(),
            inboundEmailId: r.id,
            fromAddress: extractEmailAddress(r.fromAddress ?? ""),
            subject: r.subject ?? null,
            classifiedConfidence: r.confidence ?? null,
            // Opened at the time the message ARRIVED, not now — otherwise every
            // backfilled row would read as brand new and the ageing signal,
            // which is the point, would be destroyed.
            openedAt: r.receivedAt ?? new Date(),
            status: "open",
          })
          .onConflictDoNothing()
          .returning({ id: supportObligations.id });
        if (res.length > 0) opened++;
      }

      return {
        content: [
          jsonContent({
            ok: true,
            dryRun: false,
            scanned: rows.length,
            opened,
            skippedExisting: eligible.length - opened,
          }),
        ],
      };
    }
  );
}
