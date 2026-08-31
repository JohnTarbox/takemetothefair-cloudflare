/**
 * OPE-384 stage 6 — is the outreach rail working?
 *
 * Coverage, the funnel, and the one leading quality metric the ticket names.
 *
 * The classification is imported from `@takemetothefair/db-schema`, the same
 * module the stage-2 queue uses, so "needs confirmation" means exactly one
 * thing. A metrics surface with its own definition is how a dashboard ends up
 * disagreeing with the worklist it is supposed to describe.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  events,
  promoters,
  eventDataCitations,
  promoterOutreachAttempts,
  classifyContact,
  buildOutreachFunnel,
  buildOutreachCoverage,
  medianTimeToConfirmMs,
} from "../schema.js";
import { chunkIds } from "@takemetothefair/utils";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerPromoterOutreachMetricsTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_promoter_outreach_metrics",
    [
      "OPE-384 stage 6 — coverage, the outreach funnel, and the leading quality metric.",
      "",
      "The funnel is CUMULATIVE: a confirmed attempt counts as sent, because it was.",
      "Counting status='sent' alone would under-report by exactly the successes and make",
      "the conversion rate FALL as the rail improved.",
      "",
      "`uncited_confirmed_dates` is the one to watch: events asserting dates_confirmed with",
      "no citation behind the claim — the Dartmouth failure, counted. It should trend to",
      "zero once the stage-5 gate lands.",
      "",
      "Rates are NULL, never 0, on an empty denominator: a rail that has sent nothing has no",
      "reply rate, and 0% would read as 'we asked and nobody answered'.",
      "Read-only. Admin only.",
    ].join("\n"),
    {},
    async () => {
      const now = new Date();

      const [statusRows, upcomingRows, uncitedRow] = await Promise.all([
        db
          .select({ status: promoterOutreachAttempts.status, count: sql<number>`COUNT(*)` })
          .from(promoterOutreachAttempts)
          .groupBy(promoterOutreachAttempts.status),
        db
          .select({
            id: events.id,
            datesConfirmed: events.datesConfirmed,
            promoterName: promoters.companyName,
            promoterContactEmail: promoters.contactEmail,
          })
          .from(events)
          .leftJoin(promoters, eq(promoters.id, events.promoterId))
          .where(
            and(
              eq(events.status, "APPROVED"),
              isNull(events.mergedInto),
              gte(events.startDate, now)
            )
          ),
        db
          .select({ n: sql<number>`COUNT(*)` })
          .from(promoterOutreachAttempts)
          .where(
            and(
              eq(promoterOutreachAttempts.status, "confirmed"),
              isNotNull(promoterOutreachAttempts.sentAt)
            )
          ),
      ]);

      // Which upcoming events assert confirmed dates with nothing behind them.
      // Chunked — D1 caps a statement at 100 bind parameters, and this list is
      // every upcoming event (see the stage-2 hotfix; same trap, same fix).
      const confirmedIds = upcomingRows.filter((r) => r.datesConfirmed).map((r) => r.id);
      const citedIds = new Set<string>();
      for (const chunk of chunkIds(confirmedIds, 80)) {
        const cited = await db
          .select({ eventId: eventDataCitations.eventId })
          .from(eventDataCitations)
          .where(
            and(
              inArray(eventDataCitations.eventId, chunk),
              inArray(eventDataCitations.fieldName, ["start_date", "end_date"]),
              eq(eventDataCitations.state, "active")
            )
          )
          .groupBy(eventDataCitations.eventId);
        for (const c of cited) if (c.eventId) citedIds.add(c.eventId);
      }
      const uncitedConfirmedDates = confirmedIds.filter((id) => !citedIds.has(id)).length;

      // "Needs confirmation" here is the uncited-or-unconfirmed dates signal —
      // the subset stage 2 flags for DATE reasons. Hours and vendor-application
      // gaps are real queue reasons but not what "confirmed details" coverage
      // means, and folding them in would make coverage look far worse for a
      // different problem.
      const needingConfirmation =
        uncitedConfirmedDates + upcomingRows.filter((r) => !r.datesConfirmed).length;

      const contactable = upcomingRows.filter(
        (r) =>
          classifyContact({
            promoterName: r.promoterName,
            promoterContactEmail: r.promoterContactEmail,
          }) === "contactable"
      ).length;

      const confirmedDurations = await db
        .select({
          sentAt: promoterOutreachAttempts.sentAt,
          outcomeAt: promoterOutreachAttempts.outcomeAt,
        })
        .from(promoterOutreachAttempts)
        .where(
          and(
            eq(promoterOutreachAttempts.status, "confirmed"),
            isNotNull(promoterOutreachAttempts.sentAt),
            isNotNull(promoterOutreachAttempts.outcomeAt)
          )
        );

      const medianMs = medianTimeToConfirmMs(
        confirmedDurations
          .map((d) =>
            d.sentAt && d.outcomeAt ? d.outcomeAt.getTime() - d.sentAt.getTime() : Number.NaN
          )
          .filter((n) => Number.isFinite(n))
      );

      return {
        content: [
          jsonContent({
            funnel: buildOutreachFunnel(
              statusRows.map((r) => ({ status: r.status, count: Number(r.count) }))
            ),
            coverage: buildOutreachCoverage({
              totalUpcoming: upcomingRows.length,
              needingConfirmation,
              // Contactable across ALL upcoming events, capped at the number
              // that actually need asking — reporting more contactable rows
              // than there are tasks would read as a surplus.
              contactable: Math.min(contactable, needingConfirmation),
              uncitedConfirmedDates,
            }),
            median_time_to_confirm_days:
              medianMs === null ? null : Number((medianMs / 86_400_000).toFixed(1)),
            confirmed_attempts_ever: Number(uncitedRow[0]?.n ?? 0),
            note:
              "funnel is cumulative (a confirmed attempt counts as sent). Rates are null, " +
              "not zero, on an empty denominator.",
          }),
        ],
      };
    }
  );
}
