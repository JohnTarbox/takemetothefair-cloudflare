import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { adminActions, events, eventDataCitations } from "../schema.js";
import { decodeHtmlEntities, dollarsToCents, jsonContent } from "../helpers.js";
import { normalizeEventDate } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

// Lifecycle states. Citations are never deleted in normal flow — corrections
// transition to `rejected` or `stale`. `superseded` is set automatically when
// a newer `active` citation is inserted for the same (event, field, year).
const STATE_VALUES = ["active", "superseded", "rejected", "stale"] as const;

/**
 * OPE-502 — render a raw stored epoch-SECONDS value as an ISO-8601 UTC string.
 *
 * Needed only for aggregates. Drizzle decodes `integer(..., {mode:"timestamp"})`
 * into a Date on a plain column read, but `min()`/`max()` return the underlying
 * integer untouched — so the rollup's first/last-seen would otherwise be a bare
 * number that reads like a millisecond epoch and is off by a factor of 1000.
 * Seconds-vs-milliseconds on these columns is a repeat defect here; converting
 * in one named place keeps the trap in one place too.
 */
function secondsToIso(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

const SOURCE_TYPE_VALUES = [
  "official_website",
  "news_article",
  "press_release",
  "social_media",
  "user_submitted",
  "other",
] as const;

// Map field_name → denormalized events column + value parser. When
// update_event_column=true the tool writes the parsed value into the named
// events column. Unknown field names are still recorded as citations; they
// just don't have a column to sync.
type DenormSpec = {
  column: keyof typeof events.$inferSelect;
  parse: (raw: string) => unknown;
};
const DENORM_FIELD_MAP: Record<string, DenormSpec> = {
  estimated_attendance: {
    column: "estimatedAttendance",
    parse: (raw) => {
      const cleaned = raw.replace(/[,_\s]/g, "");
      const n = parseInt(cleaned, 10);
      return Number.isFinite(n) ? n : undefined;
    },
  },
  vendor_fee_min: {
    column: "vendorFeeMinCents",
    parse: (raw) => parseDollarsToCents(raw),
  },
  vendor_fee_max: {
    column: "vendorFeeMaxCents",
    parse: (raw) => parseDollarsToCents(raw),
  },
  ticket_price_min: {
    column: "ticketPriceMinCents",
    parse: (raw) => parseDollarsToCents(raw),
  },
  ticket_price_max: {
    column: "ticketPriceMaxCents",
    parse: (raw) => parseDollarsToCents(raw),
  },
  application_deadline: {
    column: "applicationDeadline",
    parse: (raw) => {
      // OPE-505 — MUST go through normalizeEventDate. A bare `YYYY-MM-DD`
      // through `new Date()` lands at 00:00:00Z, which renders as the
      // PREVIOUS calendar day everywhere in the US. Citing a date is the
      // last step of verifying it, so the raw parser preferentially
      // corrupted events an operator had just gone to the trouble of
      // getting right. An explicit time is preserved verbatim.
      return normalizeEventDate(raw) ?? undefined;
    },
  },
  // OPE-198 — the rest of the vendor-application family, so a field populated
  // at intake (or by the OPE-192 backfill) can carry an auditable source URL.
  vendor_fee_notes: {
    column: "vendorFeeNotes",
    parse: (raw) => {
      const t = raw.trim();
      return t.length > 0 ? t : undefined;
    },
  },
  application_url: {
    column: "applicationUrl",
    parse: (raw) => {
      const t = raw.trim();
      return t.length > 0 ? t : undefined;
    },
  },
  application_instructions: {
    column: "applicationInstructions",
    parse: (raw) => {
      const t = raw.trim();
      return t.length > 0 ? t.slice(0, 500) : undefined;
    },
  },
  indoor_outdoor: {
    column: "indoorOutdoor",
    parse: (raw) => {
      const u = raw.trim().toUpperCase();
      return u === "INDOOR" || u === "OUTDOOR" || u === "MIXED" ? u : undefined;
    },
  },
  // K4 (analyst, 2026-05-31): structural fields — start_date, end_date,
  // venue_id, name. These are the highest-stakes fields on the site
  // ("trustworthy data" value prop), so corrections to them MUST carry
  // an auditable source URL. The existing update_event tool at
  // admin.ts:1072-1134 already iterates requestedFields and inserts a
  // citation per field when params.citation is provided; registering
  // these four entries here is the whole hook.
  //
  // Surfaced 5/31 during the June verification pass: Waterford date
  // Jul 20 → 19, Rangeley Jun 4 → 5, Litchfield Jun 20 → 21, Saco Arts
  // Festival → Downtown Saco, South Berwick → Central School Grounds.
  // None of those corrections had a citation row attached because the
  // map didn't recognize the field_name.
  start_date: {
    column: "startDate",
    parse: (raw) => {
      // OPE-505 — MUST go through normalizeEventDate. A bare `YYYY-MM-DD`
      // through `new Date()` lands at 00:00:00Z, which renders as the
      // PREVIOUS calendar day everywhere in the US. Citing a date is the
      // last step of verifying it, so the raw parser preferentially
      // corrupted events an operator had just gone to the trouble of
      // getting right. An explicit time is preserved verbatim.
      return normalizeEventDate(raw) ?? undefined;
    },
  },
  end_date: {
    column: "endDate",
    parse: (raw) => {
      // OPE-505 — MUST go through normalizeEventDate. A bare `YYYY-MM-DD`
      // through `new Date()` lands at 00:00:00Z, which renders as the
      // PREVIOUS calendar day everywhere in the US. Citing a date is the
      // last step of verifying it, so the raw parser preferentially
      // corrupted events an operator had just gone to the trouble of
      // getting right. An explicit time is preserved verbatim.
      return normalizeEventDate(raw) ?? undefined;
    },
  },
  venue_id: {
    column: "venueId",
    // Accept UUID or legacy 32-char hex id (matches the K5 input
    // relaxation across the citation tools — the venues.id column is
    // plain TEXT and pre-UUID-era venues use the hex form).
    parse: (raw) => {
      const trimmed = raw.trim();
      // Permissive: 32 hex chars (legacy) OR dashed UUID-ish (≥32 chars,
      // hex with dashes). Stricter validation lives at the FK level.
      if (/^[a-f0-9]{32}$/i.test(trimmed)) return trimmed;
      if (/^[a-f0-9-]{36}$/i.test(trimmed)) return trimmed;
      return undefined;
    },
  },
  name: {
    column: "name",
    // Decoded for HTML entities at the schema-validation boundary
    // (sanitizeProse in update_event, decodeHtmlEntities in
    // create_event_citation). Here we just trim and reject empty
    // strings so a NULL/whitespace value doesn't silently nuke the
    // name column.
    parse: (raw) => {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
  },
};

/**
 * OPE-505 — the ONE place a citation is allowed to touch an events column.
 *
 * Both `create_event_citation` and `bulk_create_event_citations` had their own
 * copy of this write. They drifted in what they reported (the bulk path did not
 * even surface a skip reason), and a fix applied to one would have silently
 * missed the other. There is now a single writer.
 *
 * Reports before/after rather than a bare column name. The reported incident
 * was a date being moved twelve hours by a call whose response said only
 * `event_column_updated: "startDate"` — technically a disclosure, but nothing
 * an operator could read as "I changed your value".
 */
export type DenormApplyResult = {
  column: string | null;
  previousValue: string | number | null;
  newValue: string | number | null;
  skipReason: string | null;
};

/** Render a column value for the tool response: Dates as ISO, else as-is. */
function serializeColumnValue(v: unknown): string | number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

export async function applyDenormColumn(
  db: Db,
  eventId: string,
  fieldName: string,
  rawValue: string
): Promise<DenormApplyResult> {
  const none: DenormApplyResult = {
    column: null,
    previousValue: null,
    newValue: null,
    skipReason: null,
  };

  const denorm = DENORM_FIELD_MAP[fieldName];
  if (!denorm) return { ...none, skipReason: "unknown_field_name" };

  const parsed = denorm.parse(rawValue);
  if (parsed === undefined) return { ...none, skipReason: "parse_failed" };

  const col = events[denorm.column as keyof typeof events] as never;
  const before = await db.select({ v: col }).from(events).where(eq(events.id, eventId)).limit(1);
  if (before.length === 0) return { ...none, skipReason: "event_not_found" };

  const previousValue = serializeColumnValue(before[0].v);
  const newValue = serializeColumnValue(parsed);

  // Don't write when nothing changes. `events.updated_at` is a real change
  // signal (OPE-308/332 use it for conditional GET and sitemap lastmod), so a
  // no-op citation must not bump it and invalidate caches for nothing.
  if (previousValue === newValue) {
    return { column: String(denorm.column), previousValue, newValue, skipReason: "unchanged" };
  }

  await db
    .update(events)
    .set({ [denorm.column]: parsed, updatedAt: new Date() })
    .where(eq(events.id, eventId));

  return { column: String(denorm.column), previousValue, newValue, skipReason: null };
}

function parseDollarsToCents(raw: string): number | undefined {
  // Strips "$", commas, whitespace. Rejects ranges ("$50-$75") and free text.
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  // dollarsToCents returns `number | null` for non-finite input; collapse to
  // undefined here so callers have one "skip" sentinel.
  return dollarsToCents(parseFloat(cleaned)) ?? undefined;
}

/**
 * OPE-516 — which prior citations a new one retires.
 *
 * The bug was not an unexamined `WHERE year = ?`. `sameKeyFilter` handles NULL
 * deliberately and says why. The defect is semantic: `year` was doing two jobs
 * at once — "which EDITION does this fact describe" and, accidentally, "which
 * supersede bucket does this row live in" — and the second job breaks the first.
 *
 * Every citation the inbound pipeline writes carries `year: null`. Every
 * citation a human writes carries a real year. Under one shared key the two
 * groups can never retire each other, so a correction lands beside the machine's
 * error instead of replacing it. A live event carried two `active` name
 * citations with different values, and the tool reported `superseded_count: 0`
 * — indistinguishable from "first citation for this field".
 *
 * It fails in the CORRECTING direction only, which is the worst possible bias:
 * the unattended writer is fine, and the rare deliberate fix is the one that
 * does not take.
 *
 * ── The rule, and why it is asymmetric ──────────────────────────────────
 *
 * A YEAR-STAMPED citation supersedes the same year AND year-null. A year-null
 * row is an unscoped claim about the field; a scoped one refines it, so
 * retiring it is right.
 *
 * A YEAR-NULL citation supersedes year-null only.
 *
 * The ticket asked for "and vice versa". I have not done that, and the reason
 * is the asymmetry in who writes what: the pipeline writes year-null at scale,
 * unattended. If a null citation retired every stamped row for its field, one
 * re-ingest would wipe out every per-edition citation a human had recorded —
 * strictly worse than the bug being fixed, and in the same direction (machine
 * beats human).
 *
 * The conflicting stamped rows are REPORTED instead, via `conflicts_remaining`.
 * That is what closes the acceptance's real concern — no conflict is left
 * silent — without handing the unattended writer a destructive default.
 */
function supersedeScopeFilter(eventId: string, fieldName: string, year: number | null | undefined) {
  const hasYear = year !== null && year !== undefined;
  return and(
    eq(eventDataCitations.eventId, eventId),
    eq(eventDataCitations.fieldName, fieldName),
    hasYear
      ? sql`(${eventDataCitations.year} IS NULL OR ${eventDataCitations.year} = ${year})`
      : sql`${eventDataCitations.year} IS NULL`
  );
}

/**
 * Register the 5 event_data_citations MCP tools.
 *
 * Tools:
 *   - create_event_citation        (single insert, auto-supersedes prior)
 *   - list_event_citations         (filterable read)
 *   - update_event_citation        (corrections + lifecycle transitions)
 *   - delete_event_citation        (hard delete, requires reason, audited)
 *   - bulk_create_event_citations  (best-effort batch insert)
 *
 * See plan: ~/.claude/plans/a-short-batch-of-memoized-backus.md item 1.
 */
export function registerCitationTools(server: McpServer, db: Db, auth: AuthContext, _env?: Env) {
  if (auth.role !== "ADMIN") return;

  // ── create_event_citation ─────────────────────────────────────
  server.tool(
    "create_event_citation",
    "Record provenance for a single event field value (e.g. estimated_attendance=260000 cited on fryeburgfair.org). Stores the cited value verbatim as text; optionally updates the denormalized events column to match. Auto-supersedes the prior `active` citation for the same (event, field, year). Admin only.",
    {
      // K5 (analyst, 2026-05-31): accept legacy 32-char hex ids alongside dashed
      // UUIDs to match `get_event_lifecycle_history` and friends. The DB column
      // is TEXT so the stricter Zod check was the only barrier; relaxing it lets
      // citations be attached to events imported before the UUID convention.
      event_id: z.string().min(1).describe("Event UUID (or legacy 32-char hex id)."),
      field_name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Free-text field key. Known keys that map to denormalized columns and update on insert: estimated_attendance, vendor_fee_min, vendor_fee_max, ticket_price_min, ticket_price_max, application_deadline, start_date, end_date, venue_id, name. Other keys are stored as citations only (no column sync)."
        ),
      value: z
        .string()
        .min(1)
        .max(500)
        .describe("Cited value, stored verbatim as text (e.g. '260,000' or '$50')."),
      source_url: z.string().url().describe("URL where the value was cited"),
      source_type: z.enum(SOURCE_TYPE_VALUES).describe("Category of the source"),
      source_name: z
        .string()
        .max(200)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Human-readable source label, e.g. 'fryeburgfair.org' or 'Bangor Daily News'"),
      year: z
        .number()
        .int()
        .min(1900)
        .max(2100)
        .optional()
        .describe("Year the citation applies to. Omit for evergreen values."),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Caller's confidence 0..1 (e.g. 0.95 for official site, 0.6 for social post)"),
      notes: z
        .string()
        .max(1000)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Free-text notes for future-you (context, caveats, page anchor, etc.)"),
      auto_supersede_prior: z
        .boolean()
        .default(true)
        .describe(
          "Default true. When true, prior active citation(s) for the same (event, field, year) get state='superseded'."
        ),
      update_event_column: z
        .boolean()
        .default(true)
        .describe(
          "Default true. When true AND field_name maps to a known events column AND value parses cleanly, the denormalized column is updated to match."
        ),
    },
    async (params) => {
      // Verify event exists (FK constraint will fail otherwise, but caller
      // gets a clearer error this way).
      const eventRows = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: `Event not found: ${params.event_id}` }],
          isError: true,
        };
      }

      // Zod schema defaults to true; treat undefined as the same so tests that
      // omit the flag (and any future call site that does) get the documented
      // behavior. Same for update_event_column below.
      const autoSupersede = params.auto_supersede_prior !== false;
      const updateColumn = params.update_event_column !== false;

      let supersededCount = 0;
      let supersededId: string | null = null;

      // OPE-516 — active citations left behind. `superseded_count: 0` is a
      // legitimate value (first citation for a field), so it is
      // indistinguishable from success unless the caller already knows to look.
      // A caller cannot check for a conflict it is not told about.
      let conflictsRemaining: Array<{
        id: string;
        year: number | null;
        value: string;
        source_name: string | null;
      }> = [];

      if (autoSupersede) {
        const priorActive = await db
          .select({ id: eventDataCitations.id })
          .from(eventDataCitations)
          .where(
            and(
              supersedeScopeFilter(params.event_id, params.field_name, params.year),
              eq(eventDataCitations.state, "active")
            )
          );
        if (priorActive.length > 0) {
          supersededId = priorActive[0].id;
          const ids = priorActive.map((r) => r.id);
          await db
            .update(eventDataCitations)
            .set({ state: "superseded", updatedAt: new Date() })
            .where(inArray(eventDataCitations.id, ids));
          supersededCount = ids.length;
        }

        // Anything still active for this (event, field) that the scope above
        // deliberately did not touch — a different edition's citation, or the
        // year-stamped rows a year-null write must not destroy.
        const stillActive = await db
          .select({
            id: eventDataCitations.id,
            year: eventDataCitations.year,
            value: eventDataCitations.value,
            sourceName: eventDataCitations.sourceName,
          })
          .from(eventDataCitations)
          .where(
            and(
              eq(eventDataCitations.eventId, params.event_id),
              eq(eventDataCitations.fieldName, params.field_name),
              eq(eventDataCitations.state, "active")
            )
          );
        conflictsRemaining = stillActive.map((r) => ({
          id: r.id,
          year: r.year ?? null,
          value: r.value,
          source_name: r.sourceName ?? null,
        }));
      }

      const citationId = crypto.randomUUID();
      await db.insert(eventDataCitations).values({
        id: citationId,
        eventId: params.event_id,
        fieldName: params.field_name,
        value: params.value,
        year: params.year ?? null,
        sourceUrl: params.source_url,
        sourceName: params.source_name ?? null,
        sourceType: params.source_type,
        confidence: params.confidence ?? null,
        state: "active",
        notes: params.notes ?? null,
        supersedesCitationId: supersededId,
        createdBy: auth.userId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Sync denormalized events column when the field is known and the
      // value parses. parseDollarsToCents rejects ranges like "$50-$75" so
      // those won't accidentally clobber the column. OPE-505: one shared
      // writer, and it reports what it changed.
      const applied = updateColumn
        ? await applyDenormColumn(db, params.event_id, params.field_name, params.value)
        : { column: null, previousValue: null, newValue: null, skipReason: null };
      const eventColumnUpdated = applied.skipReason === null ? applied.column : null;
      const columnSkipReason = applied.skipReason;

      return {
        content: [
          jsonContent({
            ok: true,
            citation_id: citationId,
            event_id: params.event_id,
            field_name: params.field_name,
            superseded_count: supersededCount,
            // OPE-516 — other active citations for this (event, field) that
            // SURVIVE this write. Excludes the row just written, which would
            // otherwise make every call report a conflict with itself.
            //
            // Deliberate when it is a different edition; a genuine CONFLICT
            // when it is not — and either way the caller now sees it instead of
            // reading a bare `superseded_count: 0` as success.
            conflicts_remaining: conflictsRemaining,
            event_column_updated: eventColumnUpdated,
            column_skip_reason: columnSkipReason,
            // OPE-505 — before/after for anything this call touched, matching
            // update_event's shape. `column_previous_value` is populated even
            // when the write was skipped as `unchanged`, so a caller can tell
            // "already correct" apart from "not attempted".
            column_previous_value: applied.previousValue,
            column_new_value: applied.newValue,
          }),
        ],
      };
    }
  );

  // ── list_event_citations ──────────────────────────────────────
  //
  // OPE-502 — every pre-existing filter here was EVENT-first (event_id,
  // field_name, state, year). Provenance questions are SOURCE-first — "what
  // else did this URL produce", "which rows depend on the source I am about
  // to correct" — and none of them were expressible, so answering one meant
  // listing every event and reading its citations. That works at 27 rows and
  // does not work at 2,700, and it silently misses any event outside whatever
  // status filter the sweep happened to use.
  //
  // Three implementation notes that are load-bearing:
  //
  //  1. Substring matching uses `instr()`, NOT `LIKE`. D1 caps a LIKE pattern
  //     at 50 characters and raises LIKE_PATTERN_TOO_COMPLEX past it; local
  //     SQLite's cap is 50,000, so a LIKE-based implementation passes every
  //     test here and fails in production on any needle longer than a short
  //     domain. A full source_url is routinely longer than 50 chars.
  //  2. Time filters compare against the STORED column via Drizzle's timestamp
  //     mapping, never a formatted string. Per OPE-482 the MCP surface shares
  //     the renderer's formatter, which is UTC-shifted at day boundaries — a
  //     window filtered on rendered text is wrong by up to a day at exactly
  //     the boundary rows a window query exists to find.
  //  3. `total_matching` is always returned. A capped list that looks complete
  //     is the failure mode this tool is meant to remove, so truncation is
  //     reported rather than inferred from `count === limit`.
  server.tool(
    "list_event_citations",
    "List citations event-first (event_id/field/state/year) OR source-first (source_url, source_url_contains, source_name, source_type, created_after/before, confidence bounds). Each row carries its event's name, slug and status so a source-first sweep is readable without follow-up calls. Time filters are UTC and compare against the stored timestamp, not a rendered date. Pass group_by_source=true for a per-source rollup (citation count + distinct event count) — the blast-radius answer in one call. Defaults to active citations only; include_all_states=true for full history.",
    {
      // K5: accept UUID OR legacy 32-char hex id. Matched to `get_event_lifecycle_history`.
      event_id: z
        .string()
        .min(1)
        .optional()
        .describe("Filter to one event (UUID or legacy 32-char hex id)."),
      field_name: z.string().optional().describe("Filter to one field key"),
      state: z
        .enum(STATE_VALUES)
        .optional()
        .describe("Filter to one lifecycle state. Default: only 'active'."),
      include_all_states: z
        .boolean()
        .default(false)
        .describe(
          "When true, state filter is ignored and all lifecycle states are returned (history view)."
        ),
      year: z.number().int().optional().describe("Filter to one year"),
      // ── source-first filters (OPE-502) ──
      source_url: z.string().optional().describe("Exact source_url match (case-sensitive)."),
      source_url_contains: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Case-insensitive substring match on source_url, e.g. 'forms.gle' or 'docs.google.com/forms'. Matches anywhere in the URL; combine with source_url for an exact lookup instead."
        ),
      source_name: z.string().optional().describe("Exact source_name match."),
      source_type: z.enum(SOURCE_TYPE_VALUES).optional().describe("Filter to one source_type."),
      created_after: z
        .string()
        .optional()
        .describe(
          "ISO-8601 UTC instant; returns citations created at or after it (inclusive). Compared against the stored timestamp, not a formatted date."
        ),
      created_before: z
        .string()
        .optional()
        .describe(
          "ISO-8601 UTC instant; returns citations created strictly before it (exclusive), so adjacent windows tile without double-counting."
        ),
      confidence_lt: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Only citations with confidence strictly below this. NOTE: rows with a NULL confidence are NOT returned — SQL comparisons against NULL are never true. Use confidence_missing=true to find those."
        ),
      confidence_gt: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Only citations with confidence strictly above this. NULL-confidence rows are excluded (see confidence_lt)."
        ),
      confidence_missing: z
        .boolean()
        .optional()
        .describe(
          "When true, return ONLY citations whose confidence is NULL — the rows the numeric bounds can never reach. Unscored is not the same as low-scored."
        ),
      group_by_source: z
        .boolean()
        .default(false)
        .describe(
          "Return a per-source_url rollup (citations, distinct events, first/last seen) instead of individual rows. Honors every other filter. This is the blast-radius query: 'N citations across M events depend on this URL'."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Max rows to return (1-500, default 100)"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "Rows to skip, for paging past `limit` when total_matching exceeds it. Ordering is stable (created_at desc, id desc)."
        ),
    },
    async (params) => {
      // Do NOT read `params.limit` / `params.offset` straight through. Zod's
      // `.default()` only fires when the value goes through the schema, and
      // not every caller path does — which is why the state check below is
      // `=== true` rather than truthiness. An undefined offset used in
      // arithmetic yields NaN, and `NaN < total` is false, so `truncated`
      // would report a capped page as complete: the precise lie this tool
      // exists to stop telling.
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;

      const filters = [];
      if (params.event_id) filters.push(eq(eventDataCitations.eventId, params.event_id));
      if (params.field_name) filters.push(eq(eventDataCitations.fieldName, params.field_name));
      if (params.year !== undefined) filters.push(eq(eventDataCitations.year, params.year));
      // include_all_states defaults to false (Zod). Undefined = false too.
      const includeAll = params.include_all_states === true;
      if (!includeAll) {
        filters.push(eq(eventDataCitations.state, params.state ?? "active"));
      } else if (params.state) {
        filters.push(eq(eventDataCitations.state, params.state));
      }

      if (params.source_url) filters.push(eq(eventDataCitations.sourceUrl, params.source_url));
      if (params.source_url_contains) {
        // instr(), not LIKE — see note 1 above. Both sides lowered because a
        // host is case-insensitive and a caller searching "Forms.gle" means
        // the same thing as "forms.gle".
        const needle = params.source_url_contains.toLowerCase();
        filters.push(sql`instr(lower(${eventDataCitations.sourceUrl}), ${needle}) > 0`);
      }
      if (params.source_name) filters.push(eq(eventDataCitations.sourceName, params.source_name));
      if (params.source_type) filters.push(eq(eventDataCitations.sourceType, params.source_type));

      // Reject an unparseable instant rather than silently dropping the filter
      // — a window query that quietly returns the unwindowed set is the exact
      // shape of a false "nothing changed in this period" answer.
      const badDates: string[] = [];
      const parseInstant = (raw: string, label: string): Date | undefined => {
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
          badDates.push(`${label}: ${raw}`);
          return undefined;
        }
        return d;
      };
      const after = params.created_after
        ? parseInstant(params.created_after, "created_after")
        : undefined;
      const before = params.created_before
        ? parseInstant(params.created_before, "created_before")
        : undefined;
      if (badDates.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unparseable date filter (expected ISO-8601 UTC, e.g. 2026-08-20T00:00:00Z) — ${badDates.join("; ")}`,
            },
          ],
          isError: true,
        };
      }
      if (after) filters.push(gte(eventDataCitations.createdAt, after));
      if (before) filters.push(lt(eventDataCitations.createdAt, before));

      if (params.confidence_missing === true) {
        filters.push(isNull(eventDataCitations.confidence));
      }
      if (params.confidence_lt !== undefined) {
        filters.push(lt(eventDataCitations.confidence, params.confidence_lt));
      }
      if (params.confidence_gt !== undefined) {
        filters.push(gt(eventDataCitations.confidence, params.confidence_gt));
      }

      const where = filters.length > 0 ? and(...filters) : undefined;

      if (params.group_by_source === true) {
        const groups = await db
          .select({
            source_url: eventDataCitations.sourceUrl,
            citations: sql<number>`count(*)`,
            events: sql<number>`count(distinct ${eventDataCitations.eventId})`,
            first_seen: sql<number>`min(${eventDataCitations.createdAt})`,
            last_seen: sql<number>`max(${eventDataCitations.createdAt})`,
          })
          .from(eventDataCitations)
          .where(where)
          .groupBy(eventDataCitations.sourceUrl)
          .orderBy(sql`count(*) desc`)
          .limit(limit)
          .offset(offset);

        return {
          content: [
            jsonContent({
              grouped_by: "source_url",
              sources: groups.map((g) => ({
                source_url: g.source_url,
                citations: Number(g.citations),
                events: Number(g.events),
                // min()/max() over a Drizzle timestamp column come back as the
                // raw stored integer (seconds), because the aggregate bypasses
                // the column's decoder. Convert explicitly.
                first_seen: secondsToIso(g.first_seen),
                last_seen: secondsToIso(g.last_seen),
              })),
              count: groups.length,
            }),
          ],
        };
      }

      // Two queries: the page, and the true total behind it. The total is what
      // makes a capped result honest — see note 3.
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: eventDataCitations.id,
            eventId: eventDataCitations.eventId,
            fieldName: eventDataCitations.fieldName,
            value: eventDataCitations.value,
            year: eventDataCitations.year,
            sourceUrl: eventDataCitations.sourceUrl,
            sourceName: eventDataCitations.sourceName,
            sourceType: eventDataCitations.sourceType,
            confidence: eventDataCitations.confidence,
            state: eventDataCitations.state,
            notes: eventDataCitations.notes,
            supersedesCitationId: eventDataCitations.supersedesCitationId,
            createdBy: eventDataCitations.createdBy,
            createdAt: eventDataCitations.createdAt,
            updatedAt: eventDataCitations.updatedAt,
            // leftJoin, not innerJoin: the FK cascades so an orphan should be
            // impossible, and if one ever exists this surfaces it as a row
            // with a null event instead of hiding it from a provenance sweep.
            eventName: events.name,
            eventSlug: events.slug,
            eventStatus: events.status,
          })
          .from(eventDataCitations)
          .leftJoin(events, eq(eventDataCitations.eventId, events.id))
          .where(where)
          // id is the tiebreaker so paging is stable when many citations share
          // a created_at second (a bulk_create_event_citations batch does).
          .orderBy(desc(eventDataCitations.createdAt), desc(eventDataCitations.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ n: sql<number>`count(*)` })
          .from(eventDataCitations)
          .where(where),
      ]);

      const total = Number(totalRows[0]?.n ?? 0);

      return {
        content: [
          jsonContent({
            citations: rows.map((r) => ({
              id: r.id,
              event_id: r.eventId,
              event_name: r.eventName,
              event_slug: r.eventSlug,
              event_status: r.eventStatus,
              field_name: r.fieldName,
              value: r.value,
              year: r.year,
              source_url: r.sourceUrl,
              source_name: r.sourceName,
              source_type: r.sourceType,
              confidence: r.confidence,
              state: r.state,
              notes: r.notes,
              supersedes_citation_id: r.supersedesCitationId,
              created_by: r.createdBy,
              created_at: r.createdAt,
              updated_at: r.updatedAt,
            })),
            count: rows.length,
            total_matching: total,
            offset,
            // Never make the caller infer truncation from count === limit.
            truncated: offset + rows.length < total,
          }),
        ],
      };
    }
  );

  // ── update_event_citation ─────────────────────────────────────
  server.tool(
    "update_event_citation",
    "Correct or transition a citation. Setting state to 'active' supersedes other active citations for the same (event, field, year). Use this — not delete — for the rejection / staleness flow.",
    {
      citation_id: z.string().uuid().describe("Citation ID"),
      state: z.enum(STATE_VALUES).optional().describe("New lifecycle state"),
      confidence: z.number().min(0).max(1).optional().describe("Updated confidence 0..1"),
      notes: z
        .string()
        .max(1000)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Replace notes (decoded)"),
      value: z.string().min(1).max(500).optional().describe("Correction: updated cited value"),
      source_url: z.string().url().optional().describe("Correction: updated source URL"),
      source_name: z
        .string()
        .max(200)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Correction: updated source label"),
    },
    async (params) => {
      const rows = await db
        .select()
        .from(eventDataCitations)
        .where(eq(eventDataCitations.id, params.citation_id))
        .limit(1);
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `Citation not found: ${params.citation_id}` }],
          isError: true,
        };
      }
      const prior = rows[0];

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (params.state !== undefined) updates.state = params.state;
      if (params.confidence !== undefined) updates.confidence = params.confidence;
      if (params.notes !== undefined) updates.notes = params.notes;
      if (params.value !== undefined) updates.value = params.value;
      if (params.source_url !== undefined) updates.sourceUrl = params.source_url;
      if (params.source_name !== undefined) updates.sourceName = params.source_name;

      // If transitioning TO active, supersede other actives for the same key.
      let supersededCount = 0;
      if (params.state === "active" && prior.state !== "active") {
        const others = await db
          .select({ id: eventDataCitations.id })
          .from(eventDataCitations)
          .where(
            and(
              // OPE-516 — re-activating a citation asks the same question as
              // creating one: what does this row retire? Same rule, so a
              // revived year-stamped citation also demotes the year-null one.
              supersedeScopeFilter(prior.eventId, prior.fieldName, prior.year),
              eq(eventDataCitations.state, "active")
            )
          );
        const ids = others.map((r) => r.id).filter((id) => id !== prior.id);
        if (ids.length > 0) {
          await db
            .update(eventDataCitations)
            .set({ state: "superseded", updatedAt: new Date() })
            .where(inArray(eventDataCitations.id, ids));
          supersededCount = ids.length;
        }
      }

      await db
        .update(eventDataCitations)
        .set(updates)
        .where(eq(eventDataCitations.id, params.citation_id));

      const stateChanged = params.state !== undefined && params.state !== prior.state;

      return {
        content: [
          jsonContent({
            ok: true,
            citation_id: params.citation_id,
            state_changed: stateChanged,
            previous_state: prior.state,
            new_state: updates.state ?? prior.state,
            superseded_count: supersededCount,
          }),
        ],
      };
    }
  );

  // ── delete_event_citation ─────────────────────────────────────
  server.tool(
    "delete_event_citation",
    "Hard-delete a citation. Rare — prefer update_event_citation with state='rejected' to preserve audit history. Requires a written reason; the deletion is logged to admin_actions.",
    {
      citation_id: z.string().uuid().describe("Citation ID"),
      reason: z
        .string()
        .min(10)
        .max(500)
        .describe("Why this citation is being purged (PII, garbage row, etc.). Logged for audit."),
    },
    async (params) => {
      const rows = await db
        .select()
        .from(eventDataCitations)
        .where(eq(eventDataCitations.id, params.citation_id))
        .limit(1);
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `Citation not found: ${params.citation_id}` }],
          isError: true,
        };
      }
      const prior = rows[0];

      await db.delete(eventDataCitations).where(eq(eventDataCitations.id, params.citation_id));

      await db.insert(adminActions).values({
        id: crypto.randomUUID(),
        action: "event_data_citation.delete",
        actorUserId: auth.userId ?? null,
        targetType: "event_data_citation",
        targetId: params.citation_id,
        payloadJson: JSON.stringify({
          reason: params.reason,
          snapshot: {
            event_id: prior.eventId,
            field_name: prior.fieldName,
            value: prior.value,
            year: prior.year,
            source_url: prior.sourceUrl,
            source_type: prior.sourceType,
            state: prior.state,
          },
        }),
        createdAt: new Date(),
      });

      return {
        content: [
          jsonContent({
            ok: true,
            deleted: true,
            citation_id: params.citation_id,
          }),
        ],
      };
    }
  );

  // ── bulk_create_event_citations ───────────────────────────────
  server.tool(
    "bulk_create_event_citations",
    "Best-effort batch insert. Each row follows the same shape as create_event_citation. Returns per-row errors without aborting the batch. Max 100 rows per call.",
    {
      citations: z
        .array(
          z.object({
            // K5: accept UUID OR legacy 32-char hex id (same as create_event_citation).
            event_id: z.string().min(1),
            field_name: z.string().min(1).max(64),
            value: z.string().min(1).max(500),
            source_url: z.string().url(),
            source_type: z.enum(SOURCE_TYPE_VALUES),
            source_name: z.string().max(200).transform(decodeHtmlEntities).optional(),
            year: z.number().int().min(1900).max(2100).optional(),
            confidence: z.number().min(0).max(1).optional(),
            notes: z.string().max(1000).transform(decodeHtmlEntities).optional(),
            auto_supersede_prior: z.boolean().default(true),
            update_event_column: z.boolean().default(true),
          })
        )
        .min(1)
        .max(100)
        .describe("Up to 100 citations to insert in one call"),
    },
    async ({ citations }) => {
      const created: Array<{
        index: number;
        citation_id: string;
        superseded_count: number;
        event_column_updated: string | null;
        column_skip_reason: string | null;
        column_previous_value: string | number | null;
        column_new_value: string | number | null;
      }> = [];
      const errors: Array<{ index: number; message: string }> = [];

      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        try {
          // Verify event exists (cheap check — saves an opaque FK error)
          const exists = await db
            .select({ id: events.id })
            .from(events)
            .where(eq(events.id, c.event_id))
            .limit(1);
          if (exists.length === 0) {
            errors.push({ index: i, message: `Event not found: ${c.event_id}` });
            continue;
          }

          let supersededId: string | null = null;
          let supersededCount = 0;
          const autoSupersede = c.auto_supersede_prior !== false;
          const updateColumn = c.update_event_column !== false;
          if (autoSupersede) {
            const prior = await db
              .select({ id: eventDataCitations.id })
              .from(eventDataCitations)
              .where(
                and(
                  // OPE-516 — the bulk path must retire exactly what the
                  // single path retires. Two supersede rules for one concept is
                  // how a fix ends up wired into one of two parallel paths.
                  supersedeScopeFilter(c.event_id, c.field_name, c.year),
                  eq(eventDataCitations.state, "active")
                )
              );
            if (prior.length > 0) {
              supersededId = prior[0].id;
              const ids = prior.map((r) => r.id);
              await db
                .update(eventDataCitations)
                .set({ state: "superseded", updatedAt: new Date() })
                .where(inArray(eventDataCitations.id, ids));
              supersededCount = ids.length;
            }
          }

          const citationId = crypto.randomUUID();
          await db.insert(eventDataCitations).values({
            id: citationId,
            eventId: c.event_id,
            fieldName: c.field_name,
            value: c.value,
            year: c.year ?? null,
            sourceUrl: c.source_url,
            sourceName: c.source_name ?? null,
            sourceType: c.source_type,
            confidence: c.confidence ?? null,
            state: "active",
            notes: c.notes ?? null,
            supersedesCitationId: supersededId,
            createdBy: auth.userId ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // OPE-505 — same writer as the single-citation path, so the noon
          // anchor and the before/after reporting cannot drift between them.
          const applied = updateColumn
            ? await applyDenormColumn(db, c.event_id, c.field_name, c.value)
            : { column: null, previousValue: null, newValue: null, skipReason: null };

          created.push({
            index: i,
            citation_id: citationId,
            superseded_count: supersededCount,
            event_column_updated: applied.skipReason === null ? applied.column : null,
            column_skip_reason: applied.skipReason,
            column_previous_value: applied.previousValue,
            column_new_value: applied.newValue,
          });
        } catch (err) {
          errors.push({
            index: i,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        content: [
          jsonContent({
            ok: errors.length === 0,
            created_count: created.length,
            error_count: errors.length,
            created,
            errors,
          }),
        ],
      };
    }
  );
}

// Re-export the denorm map so the update_event citation auto-insert can mirror
// the same parsing rules. Keep one source of truth for the field → column +
// parse logic; otherwise the two write paths diverge over time.
export { DENORM_FIELD_MAP, SOURCE_TYPE_VALUES, parseDollarsToCents };
