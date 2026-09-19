/**
 * OPE-1078 — `propagate_recurring_hours`: carry ONE organizer-sourced day's
 * hours forward to the sibling occurrences of a recurring market, with the
 * provenance travelling alongside.
 *
 * Why this exists: weekly farmers markets are modelled one event row per date.
 * The organizer states the hours once for the whole season ("Every Saturday
 * May–October, 9am–2pm"), a verification pass stores that once on the one date
 * it touched, and the other ~38 dates render "hours not confirmed" while the
 * answer sits in D1. The daily sweep sees one date per family per week, which
 * is exactly the arrival rate, so its backlog never drains. Read from source
 * 2026-09-19: no writer copies hours between occurrences — `create_event_day`
 * writes one row for one event, and nothing reads a sibling.
 *
 * What makes it safe to copy (each is a REFUSAL, reported per target):
 *   - the SEASON is stated by the caller from the organizer's own words, never
 *     assumed — Capital City closes at 13:00 in summer and moves venue in
 *     winter, so a neighbour's hours are plausible, uniform and wrong;
 *   - the target falls on the SAME WEEKDAY as the source day, inside the season;
 *   - the target is at the SAME VENUE as the source (a cross-family slip, or a
 *     winter venue, is refused rather than filled);
 *   - the target is a single-date occurrence with ZERO day rows — nothing is
 *     overwritten, and a rerun is a no-op (deterministic id + ON CONFLICT);
 *   - the source day has full hours and non-empty `internal_notes` — copying an
 *     unsourced row would turn one weak row into forty.
 * Hours are never derived from start/end timestamps (OPE-1011).
 *
 * The copied row is stamped `INHERITED (OPE-1078)` in `internal_notes`, which
 * carries the season quote and the source row's own provenance verbatim. The
 * PUBLIC `notes` field is never copied (OPE-572: provenance prose leaked there).
 *
 * Dry run by default. Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
 * one writer · idempotent · read back (the response re-reads what it wrote) ·
 * rollback = delete rows whose internal_notes start with the stamp.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { computePublicDates } from "@takemetothefair/utils";
import { toIsoDateOnlyInVenueZone } from "@takemetothefair/datetime";
import { events, eventDays } from "../schema.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import { recordMutation } from "../audit/record-mutation.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export const INHERITED_STAMP = "INHERITED (OPE-1078)";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Day of week of a calendar date string, independent of any zone. */
function weekday(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export type PropagationSkip =
  | "event_not_found"
  | "merged"
  | "already_has_days"
  | "multi_day_occurrence"
  | "outside_season"
  | "weekday_mismatch"
  | "different_venue"
  | "is_source_event";

export function registerPropagateHoursTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "propagate_recurring_hours",
    "OPE-1078: copy ONE organizer-sourced event_day's hours to sibling occurrences of a recurring market (one event row per date), carrying provenance. You name the targets and the season FROM THE ORGANIZER'S OWN WORDS; each target is refused unless it is a single-date occurrence with zero day rows, on the same weekday and venue as the source, inside the season. The source day must have open+close and internal_notes. Never copies the public notes. DRY RUN by default — pass dry_run=false to write. Admin only.",
    {
      source_day_id: z.string().min(1).describe("The sourced event_day to copy from."),
      target_event_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(60)
        .describe("Sibling occurrence event ids (same family). Up to 60."),
      season_start: z
        .string()
        .regex(ISO_DATE)
        .describe("First date of the season the organizer states (YYYY-MM-DD)."),
      season_end: z
        .string()
        .regex(ISO_DATE)
        .describe("Last date of the season the organizer states (YYYY-MM-DD)."),
      season_quote: z
        .string()
        .min(10)
        .max(500)
        .transform(decodeHtmlEntities)
        .describe(
          'The organizer\'s recurring statement, VERBATIM — e.g. "Join us every Saturday 9am-2pm / from May to October".'
        ),
      dry_run: z
        .boolean()
        .default(true)
        .describe("Default true: report what would be written, write nothing."),
    },
    async (params) => {
      const dryRun = params.dry_run !== false;
      if (params.season_start > params.season_end) {
        return {
          content: [{ type: "text", text: "season_start is after season_end." }],
          isError: true,
        };
      }

      const [src] = await db
        .select({
          id: eventDays.id,
          eventId: eventDays.eventId,
          date: eventDays.date,
          openTime: eventDays.openTime,
          closeTime: eventDays.closeTime,
          internalNotes: eventDays.internalNotes,
          venueId: events.venueId,
        })
        .from(eventDays)
        .innerJoin(events, eq(eventDays.eventId, events.id))
        .where(eq(eventDays.id, params.source_day_id))
        .limit(1);
      if (!src)
        return { content: [{ type: "text", text: "Source day not found." }], isError: true };
      if (!src.openTime || !src.closeTime) {
        return {
          content: [
            {
              type: "text",
              text: "Source day lacks open_time or close_time — nothing sourced to copy.",
            },
          ],
          isError: true,
        };
      }
      if (!src.internalNotes?.trim()) {
        return {
          content: [
            {
              type: "text",
              text: "Source day has no internal_notes provenance. Copying an unsourced row would multiply an unsourced claim — source it first.",
            },
          ],
          isError: true,
        };
      }
      if (src.date < params.season_start || src.date > params.season_end) {
        return {
          content: [
            {
              type: "text",
              text: `Source day ${src.date} is itself outside the stated season — check the season.`,
            },
          ],
          isError: true,
        };
      }
      const srcWeekday = weekday(src.date);

      const targets = await db
        .select({
          id: events.id,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          venueId: events.venueId,
          mergedInto: events.mergedInto,
        })
        .from(events)
        .where(inArray(events.id, params.target_event_ids));
      const byId = new Map(targets.map((t) => [t.id, t]));
      // One read for every target's existing days (≤60 ids, inside D1's cap).
      const existing = await db
        .select({ eventId: eventDays.eventId })
        .from(eventDays)
        .where(inArray(eventDays.eventId, params.target_event_ids));
      const hasDays = new Set(existing.map((d) => d.eventId));

      const planned: Array<{ event_id: string; slug: string; date: string }> = [];
      const skipped: Array<{ event_id: string; reason: PropagationSkip; detail?: string }> = [];

      for (const id of params.target_event_ids) {
        const t = byId.get(id);
        if (!t) {
          skipped.push({ event_id: id, reason: "event_not_found" });
          continue;
        }
        if (id === src.eventId) {
          skipped.push({ event_id: id, reason: "is_source_event" });
          continue;
        }
        if (t.mergedInto) {
          skipped.push({ event_id: id, reason: "merged" });
          continue;
        }
        if (hasDays.has(id)) {
          skipped.push({ event_id: id, reason: "already_has_days" });
          continue;
        }
        const date = toIsoDateOnlyInVenueZone(t.startDate);
        const endDay = toIsoDateOnlyInVenueZone(t.endDate);
        if (!date || (endDay && endDay !== date)) {
          skipped.push({
            event_id: id,
            reason: "multi_day_occurrence",
            detail: `${date}..${endDay}`,
          });
          continue;
        }
        if (date < params.season_start || date > params.season_end) {
          skipped.push({ event_id: id, reason: "outside_season", detail: date });
          continue;
        }
        if (weekday(date) !== srcWeekday) {
          skipped.push({ event_id: id, reason: "weekday_mismatch", detail: date });
          continue;
        }
        if ((t.venueId ?? null) !== (src.venueId ?? null)) {
          skipped.push({ event_id: id, reason: "different_venue" });
          continue;
        }
        planned.push({ event_id: id, slug: t.slug, date });
      }

      const internalNotes =
        `${INHERITED_STAMP} from day ${src.id} (${src.date}). ` +
        `Season stated by the organizer: "${params.season_quote}" [${params.season_start}..${params.season_end}]. ` +
        `Source provenance: ${src.internalNotes}`;

      const written: string[] = [];
      if (!dryRun) {
        for (const p of planned) {
          const dayId = `evd_${p.event_id}_${p.date}`;
          await db
            .insert(eventDays)
            .values({
              id: dayId,
              eventId: p.event_id,
              date: p.date,
              openTime: src.openTime,
              closeTime: src.closeTime,
              notes: null,
              internalNotes,
              vendorOnly: false,
            })
            .onConflictDoNothing();
          const days = await db
            .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
            .from(eventDays)
            .where(eq(eventDays.eventId, p.event_id));
          const { publicStartDate, publicEndDate } = computePublicDates(days);
          await db
            .update(events)
            .set({ publicStartDate, publicEndDate, updatedAt: new Date() })
            .where(and(eq(events.id, p.event_id), isNull(events.mergedInto)));
          await recordMutation(db, {
            entityType: "event_day",
            entityId: dayId,
            verb: "create",
            actor: auth.userId ?? "mcp:propagate_recurring_hours",
            after: {
              date: p.date,
              openTime: src.openTime,
              closeTime: src.closeTime,
              inheritedFrom: src.id,
            },
            note: `mcp propagate_recurring_hours from ${src.id} (OPE-1078)`,
          });
          written.push(dayId);
        }
      }

      // Read back what was written rather than reporting the plan as the result.
      const readBack = written.length
        ? await db
            .select({
              id: eventDays.id,
              openTime: eventDays.openTime,
              closeTime: eventDays.closeTime,
            })
            .from(eventDays)
            .where(inArray(eventDays.id, written))
        : [];

      return {
        content: [
          jsonContent({
            dry_run: dryRun,
            source: {
              day_id: src.id,
              date: src.date,
              open_time: src.openTime,
              close_time: src.closeTime,
            },
            targets_named: params.target_event_ids.length,
            planned: planned.length,
            skipped_count: skipped.length,
            written: readBack.length,
            planned_rows: planned,
            skipped,
            read_back: readBack,
          }),
        ],
      };
    }
  );
}
