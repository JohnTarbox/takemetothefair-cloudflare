/**
 * OPE-384 stage 2 — the drainable queue of events needing promoter confirmation.
 *
 * Stage 1 shipped the ability to ASK. This is the answer to "ask about what?",
 * and without it the capability only ever fires when a human happens to notice
 * something looks wrong — which is the exact manual process the ticket exists
 * to replace ("a human notices an event looks wrong and hand-emails the
 * organizer").
 *
 * ── Two things this queue does that a naive version would not ─────────────
 *
 * 1. It surfaces UN-CONTACTABLE events instead of hiding them. Most of the
 *    backlog is not "we haven't asked" but "we have nobody to ask", and a
 *    queue filtered to actionable rows would report a small, tidy number while
 *    the real work — attaching organizer contacts — stayed invisible. Those
 *    rows come back marked `blocked_on: "promoter_enrichment"`.
 *
 * 2. It suppresses events with an OPEN attempt. The DB already refuses a second
 *    open attempt per event (a partial unique index from stage 1), but a queue
 *    that kept listing them would hand an operator a task whose only possible
 *    outcome is a constraint error. Enforcement and presentation are different
 *    jobs; both are needed.
 *
 * The classification itself lives in `@takemetothefair/db-schema` so the
 * stage-6 metrics count exactly what this queue lists — one definition of
 * "needs confirmation", not two that drift.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  events,
  promoters,
  eventDays,
  eventDataCitations,
  promoterOutreachAttempts,
  buildOutreachQueueRow,
  type OutreachQueueRow,
} from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** Date fields whose citations count as "these dates are backed by a source". */
const DATE_CITATION_FIELDS = ["start_date", "end_date"];

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function registerPromoterOutreachQueueTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_promoter_outreach_queue",
    [
      "OPE-384 stage 2 — events whose details need confirming BY THE ORGANIZER, with the",
      "reason(s) and whether we can actually reach anyone about them.",
      "",
      "Reasons: dates_unconfirmed · dates_confirmed_uncited (the flag says somebody decided,",
      "zero citations say nobody could show why — the Dartmouth shape) · dates_pending_official_tag ·",
      "started_but_never_updated · missing_hours · missing_vendor_application.",
      "",
      "Rows we CANNOT act on are included, not hidden, marked blocked_on='promoter_enrichment'.",
      "Most of this backlog is 'nobody to ask', not 'not asked yet', and filtering those out",
      "would report a tidy number while the real work stayed invisible.",
      "",
      "Events with an OPEN outreach attempt are suppressed — the DB refuses a second one, so",
      "listing them would hand you a task whose only outcome is a constraint error.",
      "Read-only. Admin only.",
    ].join("\n"),
    {
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
      actionable_only: z
        .boolean()
        .optional()
        .describe(
          "Only rows we can email today. Default FALSE — see the note about hiding the backlog."
        ),
      include_past: z
        .boolean()
        .optional()
        .describe("Include events whose start date has passed (default false)."),
    },
    async (params) => {
      const limit = params.limit ?? 50;
      const now = new Date();

      const rows = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          startDate: events.startDate,
          datesConfirmed: events.datesConfirmed,
          tags: events.tags,
          lifecycleStatus: events.lifecycleStatus,
          commercialVendorsAllowed: events.commercialVendorsAllowed,
          vendorApplicationUrl: events.applicationUrl,
          promoterName: promoters.companyName,
          promoterId: promoters.id,
          promoterContactEmail: promoters.contactEmail,
        })
        .from(events)
        .leftJoin(promoters, eq(promoters.id, events.promoterId))
        .where(
          and(
            eq(events.status, "APPROVED"),
            isNull(events.mergedInto),
            params.include_past
              ? sql`1 = 1`
              : or(isNull(events.startDate), gte(events.startDate, now))!
          )
        )
        // Read wider than `limit`: the classifier rejects most rows, so
        // limiting the QUERY would return a near-empty page and read as "the
        // queue is almost clear".
        .limit(Math.max(limit * 10, 200));

      if (rows.length === 0) {
        return { content: [jsonContent({ total: 0, queue: [] })] };
      }

      const ids = rows.map((r) => r.id);

      // Batched, because a per-event count would be three queries per row.
      const [dayCounts, citationCounts, openAttempts] = await Promise.all([
        db
          .select({ eventId: eventDays.eventId, n: sql<number>`COUNT(*)` })
          .from(eventDays)
          .where(inArray(eventDays.eventId, ids))
          .groupBy(eventDays.eventId),
        db
          .select({ eventId: eventDataCitations.eventId, n: sql<number>`COUNT(*)` })
          .from(eventDataCitations)
          .where(
            and(
              inArray(eventDataCitations.eventId, ids),
              inArray(eventDataCitations.fieldName, DATE_CITATION_FIELDS),
              eq(eventDataCitations.state, "active")
            )
          )
          .groupBy(eventDataCitations.eventId),
        db
          .select({ eventId: promoterOutreachAttempts.eventId })
          .from(promoterOutreachAttempts)
          .where(
            and(
              inArray(promoterOutreachAttempts.eventId, ids),
              inArray(promoterOutreachAttempts.status, ["queued", "sent"])
            )
          ),
      ]);

      const days = new Map(dayCounts.map((d) => [d.eventId, Number(d.n)]));
      const cites = new Map(citationCounts.map((c) => [c.eventId, Number(c.n)]));
      const open = new Set(openAttempts.map((a) => a.eventId).filter((x): x is string => !!x));

      const queue: Array<OutreachQueueRow & Record<string, unknown>> = [];
      let suppressedOpen = 0;

      for (const r of rows) {
        if (open.has(r.id)) {
          suppressedOpen++;
          continue;
        }
        const row = buildOutreachQueueRow(
          r.id,
          {
            startDate: r.startDate,
            datesConfirmed: r.datesConfirmed,
            dateCitationCount: cites.get(r.id) ?? 0,
            tags: parseTags(r.tags),
            lifecycleStatus: r.lifecycleStatus,
            eventDayCount: days.get(r.id) ?? 0,
            commercialVendorsAllowed: r.commercialVendorsAllowed,
            vendorApplicationUrl: r.vendorApplicationUrl,
            promoterName: r.promoterName,
            promoterContactEmail: r.promoterContactEmail,
          },
          now
        );
        if (!row) continue;
        if (params.actionable_only && !row.actionable) continue;
        queue.push({
          ...row,
          slug: r.slug,
          name: r.name,
          start_date: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
          promoter_id: r.promoterId,
          promoter_name: r.promoterName,
        });
        if (queue.length >= limit) break;
      }

      const blocked = queue.filter((q) => !q.actionable).length;
      return {
        content: [
          jsonContent({
            total: queue.length,
            actionable: queue.length - blocked,
            blocked_on_promoter_enrichment: blocked,
            // Reported rather than silent: a queue that shrank because asks are
            // already open reads identically to one that shrank because the
            // data got better.
            suppressed_open_attempts: suppressedOpen,
            scanned: rows.length,
            queue,
          }),
        ],
      };
    }
  );
}
