/**
 * GW1.2 (2026-06-03) — Reliability-weighted flip of an event field.
 *
 * Called from the check-duplicate route when reliability-resolution
 * decides the candidate's source value should replace the existing
 * stored value. Performs the same 3-step transition the MCP K4
 * `create_event_citation` tool would:
 *
 *   1. Supersede prior `active` citation for (event, field_name, year)
 *      → state='superseded', updatedAt=now.
 *   2. INSERT new active citation pointing at the candidate's source URL.
 *   3. UPDATE events.<column> with the parsed new value.
 *
 * Uses `db.batch` for atomicity per
 * [[feedback_destructive_delete_needs_transaction]] — the middle step
 * (supersede) without the third (insert) would leave the citation set
 * with NO active row, a worse state than either pre- or post-flip.
 *
 * ## V1 field-class support
 *
 * Only `date` (start_date) and `name` are wired today:
 *
 *   - `venue` flips are deferred because GW1.1's comparator doesn't
 *     resolve the candidate's venue strings to a venueId — we don't
 *     have a value to write into events.venue_id. When the comparator
 *     starts pre-resolving venues (via autoLinkVenue), this helper's
 *     switch can grow a venue arm.
 *   - Other field_classes (`hours`/`status`/`price`/`existence`) don't
 *     come through the ingest path's comparator, so they're out of
 *     scope for GW1.2.
 *
 * ## Why this code lives in main app, not MCP
 *
 * The K4 citation insert lives in the MCP `create_event_citation`
 * tool. Calling it from the main-app route would require either a
 * new MCP HTTP endpoint or invoking the tool via the MCP transport —
 * both overkill for a 3-statement transaction. The trade-off: this
 * file MUST stay in lockstep with `mcp-server/src/tools/admin-
 * citations.ts:240-307` (the K4 hook). If the K4 supersede rules
 * change in MCP, mirror them here too.
 *
 * Audited divergence vs the MCP K4 path (intentional):
 *   - `createdBy` is null here (no auth.userId at ingest); MCP uses
 *     auth.userId. Logged behavior, not a structural diff.
 *   - We do NOT emit an `admin_actions` row. The MCP K4 path also
 *     doesn't (admin_actions is written by the calling MCP tool, not
 *     the citation helper). Same shape, intentional.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, eventDataCitations } from "@/lib/db/schema";

/** What we can flip today. See header for why `venue` is deferred. */
export type FlippableFieldClass = "date" | "name";

export interface FlipEventFieldArgs {
  eventId: string;
  fieldClass: FlippableFieldClass;
  /** The candidate's claim (the winning value). Strings throughout —
   *  the parse step converts to the events-column type. */
  newValue: string;
  /** Candidate's full source URL — recorded on the citation row. */
  sourceUrl: string;
  /** K4 citation source_type. Default 'other' is conservative; the
   *  caller may pass 'official_website' / 'news_article' when known. */
  sourceType?:
    | "official_website"
    | "news_article"
    | "press_release"
    | "social_media"
    | "user_submitted"
    | "other";
  /** Optional human note appended to the citation row's `notes`. */
  notes?: string;
}

export interface FlipResult {
  /** ID of the newly-inserted citation row. */
  citationId: string;
  /** ID of the prior active citation that was superseded (null when
   *  there wasn't one — first citation for this bucket). */
  supersededCitationId: string | null;
  /** Which events-column was written (for log + caller audit). */
  eventColumn: "startDate" | "name";
}

/**
 * Apply the flip. Returns the citation+column write info on success,
 * or null when the value couldn't be parsed (no write performed —
 * defensive against pathological candidate values like "tomorrow" in
 * a date arm).
 *
 * `db.batch` ensures the supersede+insert pair is atomic; the events
 * UPDATE runs after the batch since it's idempotent and not part of
 * the citation lifecycle invariant.
 */
export async function flipEventField(
  db: Database,
  args: FlipEventFieldArgs
): Promise<FlipResult | null> {
  const fieldName = fieldNameForClass(args.fieldClass);
  if (!fieldName) return null;

  const parsedValue = parseValueForColumn(args.fieldClass, args.newValue);
  if (parsedValue === undefined) {
    // Bad parse → don't touch anything. The discrepancy row already
    // captured the divergent value as text; the scorer can still use it.
    return null;
  }

  // Year bucket for the citation. For start_date, use the candidate's
  // year (post-parse). For name, year is NULL (evergreen).
  const year =
    args.fieldClass === "date" && parsedValue instanceof Date ? parsedValue.getUTCFullYear() : null;

  // 1. Find prior active citation in this bucket.
  const priorActive = await db
    .select({ id: eventDataCitations.id })
    .from(eventDataCitations)
    .where(
      and(
        eq(eventDataCitations.eventId, args.eventId),
        eq(eventDataCitations.fieldName, fieldName),
        eq(eventDataCitations.state, "active"),
        year === null ? sql`${eventDataCitations.year} IS NULL` : eq(eventDataCitations.year, year)
      )
    );
  const supersededId = priorActive.length > 0 ? priorActive[0].id : null;

  const citationId = crypto.randomUUID();
  const now = new Date();

  // 2. Atomic: supersede + insert. The events UPDATE comes after —
  // it's safe to retry independently.
  if (supersededId) {
    await db.batch([
      db
        .update(eventDataCitations)
        .set({ state: "superseded", updatedAt: now })
        .where(
          inArray(
            eventDataCitations.id,
            priorActive.map((r) => r.id)
          )
        ),
      db.insert(eventDataCitations).values({
        id: citationId,
        eventId: args.eventId,
        fieldName,
        value: args.newValue,
        year,
        sourceUrl: args.sourceUrl,
        sourceName: null,
        sourceType: args.sourceType ?? "other",
        confidence: null,
        state: "active",
        notes: args.notes ?? "gw1.2 reliability-weighted flip",
        supersedesCitationId: supersededId,
        createdBy: null, // ingest path — no user; matches K4 'system' shape
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } else {
    // First citation for this bucket — single INSERT, no supersede.
    await db.insert(eventDataCitations).values({
      id: citationId,
      eventId: args.eventId,
      fieldName,
      value: args.newValue,
      year,
      sourceUrl: args.sourceUrl,
      sourceName: null,
      sourceType: args.sourceType ?? "other",
      confidence: null,
      state: "active",
      notes: args.notes ?? "gw1.2 reliability-weighted flip",
      supersedesCitationId: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // 3. Sync denormalized events column.
  if (args.fieldClass === "date") {
    await db
      .update(events)
      .set({ startDate: parsedValue as Date, updatedAt: now })
      .where(eq(events.id, args.eventId));
    return {
      citationId,
      supersededCitationId: supersededId,
      eventColumn: "startDate",
    };
  }
  // name
  await db
    .update(events)
    .set({ name: parsedValue as string, updatedAt: now })
    .where(eq(events.id, args.eventId));
  return {
    citationId,
    supersededCitationId: supersededId,
    eventColumn: "name",
  };
}

/** Map ingest fieldClass → events column name + citation field_name. */
function fieldNameForClass(fc: FlippableFieldClass): "start_date" | "name" {
  return fc === "date" ? "start_date" : "name";
}

/** Parse the candidate's string into the events-column type. Returns
 *  undefined on bad input (caller skips the flip). */
function parseValueForColumn(fc: FlippableFieldClass, raw: string): Date | string | undefined {
  if (fc === "date") {
    // Accept YYYY-MM-DD without timezone shift (Date('2026-06-08')
    // parses as UTC midnight in JS, which is what we want for an
    // all-day event).
    const direct = raw.match(/^\d{4}-\d{2}-\d{2}/);
    if (direct) {
      const d = new Date(direct[0] + "T00:00:00.000Z");
      return isNaN(d.getTime()) ? undefined : d;
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? undefined : d;
  }
  // name: trim, reject empty
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
