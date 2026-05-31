import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { adminActions, events, eventDataCitations } from "../schema.js";
import { decodeHtmlEntities, dollarsToCents, jsonContent } from "../helpers.js";
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
      const d = new Date(raw);
      return isNaN(d.getTime()) ? undefined : d;
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
      const d = new Date(raw);
      return isNaN(d.getTime()) ? undefined : d;
    },
  },
  end_date: {
    column: "endDate",
    parse: (raw) => {
      const d = new Date(raw);
      return isNaN(d.getTime()) ? undefined : d;
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

function parseDollarsToCents(raw: string): number | undefined {
  // Strips "$", commas, whitespace. Rejects ranges ("$50-$75") and free text.
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  // dollarsToCents returns `number | null` for non-finite input; collapse to
  // undefined here so callers have one "skip" sentinel.
  return dollarsToCents(parseFloat(cleaned)) ?? undefined;
}

// Citations are scoped by (event_id, field_name, year). `year IS NULL` is its
// own bucket (evergreen citations like founding year) — we match NULL to NULL
// explicitly because SQL `=` treats them as unequal.
function sameKeyFilter(eventId: string, fieldName: string, year: number | null | undefined) {
  return and(
    eq(eventDataCitations.eventId, eventId),
    eq(eventDataCitations.fieldName, fieldName),
    year === null || year === undefined
      ? sql`${eventDataCitations.year} IS NULL`
      : eq(eventDataCitations.year, year)
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

      if (autoSupersede) {
        const priorActive = await db
          .select({ id: eventDataCitations.id })
          .from(eventDataCitations)
          .where(
            and(
              sameKeyFilter(params.event_id, params.field_name, params.year),
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
      // those won't accidentally clobber the column.
      let eventColumnUpdated: string | null = null;
      let columnSkipReason: string | null = null;
      if (updateColumn) {
        const denorm = DENORM_FIELD_MAP[params.field_name];
        if (!denorm) {
          columnSkipReason = "unknown_field_name";
        } else {
          const parsed = denorm.parse(params.value);
          if (parsed === undefined) {
            columnSkipReason = "parse_failed";
          } else {
            await db
              .update(events)
              .set({ [denorm.column]: parsed, updatedAt: new Date() })
              .where(eq(events.id, params.event_id));
            eventColumnUpdated = String(denorm.column);
          }
        }
      }

      return {
        content: [
          jsonContent({
            ok: true,
            citation_id: citationId,
            event_id: params.event_id,
            field_name: params.field_name,
            superseded_count: supersededCount,
            event_column_updated: eventColumnUpdated,
            column_skip_reason: columnSkipReason,
          }),
        ],
      };
    }
  );

  // ── list_event_citations ──────────────────────────────────────
  server.tool(
    "list_event_citations",
    "List citations, optionally filtered by event, field, state, or year. Defaults to only active citations; pass include_all_states=true to include the full history.",
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Max rows to return (1-500, default 100)"),
    },
    async (params) => {
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

      const rows = await db
        .select()
        .from(eventDataCitations)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(eventDataCitations.createdAt))
        .limit(params.limit);

      return {
        content: [
          jsonContent({
            citations: rows.map((r) => ({
              id: r.id,
              event_id: r.eventId,
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
              sameKeyFilter(prior.eventId, prior.fieldName, prior.year),
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
                  sameKeyFilter(c.event_id, c.field_name, c.year),
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

          let eventColumnUpdated: string | null = null;
          if (updateColumn) {
            const denorm = DENORM_FIELD_MAP[c.field_name];
            if (denorm) {
              const parsed = denorm.parse(c.value);
              if (parsed !== undefined) {
                await db
                  .update(events)
                  .set({ [denorm.column]: parsed, updatedAt: new Date() })
                  .where(eq(events.id, c.event_id));
                eventColumnUpdated = String(denorm.column);
              }
            }
          }

          created.push({
            index: i,
            citation_id: citationId,
            superseded_count: supersededCount,
            event_column_updated: eventColumnUpdated,
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
