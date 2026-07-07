/**
 * OPE-113 — performer-tracking Phase 1 MCP tools (mirror the vendor toolset).
 *
 * CRUD + linking surface for the `performers` / `event_performers` tables
 * (OPE-112). Direct D1 writes via the MCP `db`, admin-only. One `event_performers`
 * row = one APPEARANCE/set — a performer can appear multiple times at one event,
 * so the appearance key includes `performance_start` (OPE-112). Provenance:
 * every appearance write stores `source_url`, and status gates public emission
 * later (Phase 2) — CONFIRMED only.
 *
 * Deliberately NOT here: `enrich_performer` (Phase 4 / OPE-116) and the admin UI
 * (OPE-113 PR #2). Fuzzy dedup on create surfaces likely matches for manual
 * confirm and relies on the alias table, not the score alone (spec §4.1).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, isNull, like } from "drizzle-orm";
import { performers, eventPerformers, performerSlugHistory, adminActions } from "../schema.js";
import { appendSlugSegment, createSlug, escapeLike, jsonContent, unsafeSlug } from "../helpers.js";
import { combinedSimilarity } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const PERFORMER_TYPE = ["PERSON", "GROUP"] as const;
const ACT_CATEGORY = [
  "MUSIC",
  "ANIMAL_SHOW",
  "MAGIC",
  "COMEDY",
  "CIRCUS",
  "DANCE",
  "THEATER",
  "EDUCATIONAL",
  "CHILDRENS",
  "DEMONSTRATION",
  "OTHER",
] as const;
const BILLING = ["HEADLINER", "FEATURED", "SUPPORTING"] as const;
const APPEARANCE_STATUS = ["CONFIRMED", "PENDING", "CANCELLED"] as const;

/** ≥ this fuzzy score is a likely duplicate — but the known dash/abbrev misses
 *  (e.g. "Mr Drew" vs "Mr. Drew and His Animals Too") mean we SURFACE matches
 *  for manual confirm rather than auto-linking on the score alone (spec §4.1). */
const FUZZY_THRESHOLD = 0.92;
const FUZZY_CANDIDATE_CAP = 200;

type ErrOut = { content: Array<{ type: "text"; text: string }>; isError: true };
function err(error: string, message: string): ErrOut {
  return { content: [jsonContent({ error, message })], isError: true };
}

/** epoch-seconds int ↔ Date for the mode:"timestamp" columns. */
const toDate = (sec: number | null | undefined): Date | null =>
  sec == null ? null : new Date(sec * 1000);
const toSec = (d: Date | null | undefined): number | null =>
  d == null ? null : Math.floor(d.getTime() / 1000);

/** Slug for a new performer name, made unique against existing performers. */
async function ensureUniquePerformerSlug(db: Db, name: string): Promise<string> {
  const base = createSlug(name);
  const existing = await db
    .select({ id: performers.id })
    .from(performers)
    .where(eq(performers.slug, base))
    .limit(1);
  if (existing.length === 0) return base;
  // Collision — append a short random segment (same approach as vendors).
  return appendSlugSegment(base, crypto.randomUUID().slice(0, 8));
}

/** WHERE for one appearance identity (handles NULL day/start — SQLite treats
 *  NULLs as distinct in the UNIQUE index, so the app must match them here). */
function appearanceWhere(
  eventId: string,
  performerId: string,
  eventDayId: string | null,
  performanceStart: Date | null
) {
  return and(
    eq(eventPerformers.eventId, eventId),
    eq(eventPerformers.performerId, performerId),
    eventDayId == null
      ? isNull(eventPerformers.eventDayId)
      : eq(eventPerformers.eventDayId, eventDayId),
    performanceStart == null
      ? isNull(eventPerformers.performanceStart)
      : eq(eventPerformers.performanceStart, performanceStart)
  );
}

async function logAction(
  db: Db,
  auth: AuthContext,
  action: string,
  targetId: string,
  payload: Record<string, unknown>
) {
  await db.insert(adminActions).values({
    action,
    actorUserId: auth.userId,
    targetType: "performer",
    targetId,
    payloadJson: JSON.stringify(payload),
    createdAt: new Date(),
  });
}

function performerOut(row: typeof performers.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    performer_type: row.performerType,
    act_category: row.actCategory,
    website: row.website,
    home_base_city: row.homeBaseCity,
    home_base_state: row.homeBaseState,
    verified: row.verified,
    claimed: row.claimed,
    deleted_at: toSec(row.deletedAt),
    alias_of_performer_id: row.aliasOfPerformerId,
    redirect_to_performer_id: row.redirectToPerformerId,
  };
}

function appearanceOut(row: typeof eventPerformers.$inferSelect) {
  return {
    id: row.id,
    event_id: row.eventId,
    performer_id: row.performerId,
    event_day_id: row.eventDayId,
    performance_start: toSec(row.performanceStart),
    performance_end: toSec(row.performanceEnd),
    stage: row.stage,
    billing: row.billing,
    status: row.status,
    source_url: row.sourceUrl,
  };
}

/** Shared writable performer fields (create + update). */
const performerFields = {
  performer_type: z
    .enum(PERFORMER_TYPE)
    .optional()
    .describe("PERSON (solo) or GROUP (band/troupe)."),
  act_category: z
    .enum(ACT_CATEGORY)
    .optional()
    .describe("Act category — drives display + schema.org @type."),
  description: z.string().optional().describe("Bio."),
  website: z.string().url().optional().describe("Official site."),
  social_links: z.string().optional().describe("JSON of FB/IG/YouTube links."),
  image_url: z.string().url().optional().describe("Hero image URL (CDN host)."),
  home_base_city: z.string().optional(),
  home_base_state: z.string().optional(),
  contact_name: z.string().optional(),
  contact_email: z.string().optional(),
  contact_phone: z.string().optional(),
};

/** Map the shared field params → performers column values (only provided keys). */
function performerValues(p: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (p.performer_type !== undefined) v.performerType = p.performer_type;
  if (p.act_category !== undefined) v.actCategory = p.act_category;
  if (p.description !== undefined) v.description = p.description;
  if (p.website !== undefined) v.website = p.website;
  if (p.social_links !== undefined) v.socialLinks = p.social_links;
  if (p.image_url !== undefined) v.imageUrl = p.image_url;
  if (p.home_base_city !== undefined) v.homeBaseCity = p.home_base_city;
  if (p.home_base_state !== undefined) v.homeBaseState = p.home_base_state;
  if (p.contact_name !== undefined) v.contactName = p.contact_name;
  if (p.contact_email !== undefined) v.contactEmail = p.contact_email;
  if (p.contact_phone !== undefined) v.contactPhone = p.contact_phone;
  return v;
}

export function registerPerformerTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // ── create_performer ──────────────────────────────────────────────
  server.tool(
    "create_performer",
    "Create a performer (act that appears at events, e.g. 'Mr. Drew and His Animals Too'). Generates a unique slug from the name. Does NOT dedup — use create_or_link_performer when adding an act to an event so fuzzy-dup detection runs. Admin only.",
    {
      name: z.string().min(1).describe("Act/stage name."),
      ...performerFields,
    },
    async (params) => {
      try {
        const slug = await ensureUniquePerformerSlug(db, params.name);
        const now = new Date();
        const rows = await db
          .insert(performers)
          .values({
            name: params.name,
            slug: unsafeSlug(slug),
            ...performerValues(params),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await logAction(db, auth, "performer.create", rows[0].id, { name: params.name, slug });
        return { content: [jsonContent({ success: true, performer: performerOut(rows[0]) })] };
      } catch (e) {
        return err("create_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── update_performer ──────────────────────────────────────────────
  server.tool(
    "update_performer",
    "Update a performer's fields (not its slug — slug changes go through merge/alias). Only provided fields change. Admin only.",
    {
      performer_id: z.string().min(1),
      name: z.string().min(1).optional().describe("New display name (slug is left unchanged)."),
      ...performerFields,
    },
    async (params) => {
      try {
        const values = performerValues(params);
        if (params.name !== undefined) values.name = params.name;
        if (Object.keys(values).length === 0) return err("no_fields", "No fields to update.");
        values.updatedAt = new Date();
        const rows = await db
          .update(performers)
          .set(values)
          .where(eq(performers.id, params.performer_id))
          .returning();
        if (rows.length === 0) return err("not_found", `No performer ${params.performer_id}.`);
        await logAction(db, auth, "performer.update", rows[0].id, {
          fields: Object.keys(values),
        });
        return { content: [jsonContent({ success: true, performer: performerOut(rows[0]) })] };
      } catch (e) {
        return err("update_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── delete_performer (soft) ───────────────────────────────────────
  server.tool(
    "delete_performer",
    "Soft-delete a performer (sets deleted_at; the row and its appearances remain for audit). Reversible via undelete_performer. Admin only.",
    { performer_id: z.string().min(1) },
    async (params) => {
      try {
        const rows = await db
          .update(performers)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(performers.id, params.performer_id))
          .returning();
        if (rows.length === 0) return err("not_found", `No performer ${params.performer_id}.`);
        await logAction(db, auth, "performer.delete", rows[0].id, {});
        return { content: [jsonContent({ success: true, performer: performerOut(rows[0]) })] };
      } catch (e) {
        return err("delete_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── undelete_performer ────────────────────────────────────────────
  server.tool(
    "undelete_performer",
    "Restore a soft-deleted performer (clears deleted_at). Admin only.",
    { performer_id: z.string().min(1) },
    async (params) => {
      try {
        const rows = await db
          .update(performers)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(performers.id, params.performer_id))
          .returning();
        if (rows.length === 0) return err("not_found", `No performer ${params.performer_id}.`);
        await logAction(db, auth, "performer.undelete", rows[0].id, {});
        return { content: [jsonContent({ success: true, performer: performerOut(rows[0]) })] };
      } catch (e) {
        return err("undelete_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── search_performers ─────────────────────────────────────────────
  server.tool(
    "search_performers",
    "Search performers by name (case-insensitive substring). Excludes soft-deleted by default. Admin only.",
    {
      query: z.string().min(1),
      include_deleted: z
        .boolean()
        .optional()
        .describe("Include soft-deleted rows (default false)."),
      limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25)."),
    },
    async (params) => {
      try {
        const conds = [like(performers.name, `%${escapeLike(params.query)}%`)];
        if (!params.include_deleted) conds.push(isNull(performers.deletedAt));
        const rows = await db
          .select()
          .from(performers)
          .where(and(...conds))
          .limit(params.limit ?? 25);
        return {
          content: [
            jsonContent({ success: true, count: rows.length, performers: rows.map(performerOut) }),
          ],
        };
      } catch (e) {
        return err("search_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── create_or_link_performer ──────────────────────────────────────
  server.tool(
    "create_or_link_performer",
    "Add an act to an event: fuzzy-dedup against existing performers by name, then create the appearance (event_performers row). If a likely duplicate is found (>=0.92 combined similarity) it is NOT auto-linked — the matches are returned for manual confirm (dash/abbrev variants like 'Mr Drew' vs 'Mr. Drew and His Animals Too' slip fuzzy matching; use set_performer_alias for those). Pass performer_id to skip dedup and link a known act. One call = one appearance/set. Admin only.",
    {
      event_id: z.string().min(1),
      name: z.string().min(1).describe("Act name (used for fuzzy-dedup + create)."),
      performer_id: z
        .string()
        .optional()
        .describe("Skip dedup and link this exact performer (from a prior search/confirm)."),
      confirm_create_new: z
        .boolean()
        .optional()
        .describe("Force-create a new performer even if fuzzy matches exist."),
      event_day_id: z.string().optional(),
      performance_start: z.number().int().optional().describe("Set start (epoch seconds)."),
      performance_end: z.number().int().optional().describe("Set end (epoch seconds)."),
      stage: z.string().optional(),
      billing: z.enum(BILLING).optional(),
      status: z.enum(APPEARANCE_STATUS).optional().describe("Default PENDING."),
      source_url: z.string().describe("Provenance — where this appearance was learned (required)."),
      ...performerFields,
    },
    async (params) => {
      try {
        let performerId = params.performer_id;

        if (!performerId) {
          // Fuzzy-dedup by name over live performers (capped scan).
          const candidates = await db
            .select({ id: performers.id, name: performers.name, slug: performers.slug })
            .from(performers)
            .where(isNull(performers.deletedAt))
            .limit(FUZZY_CANDIDATE_CAP);
          const matches = candidates
            .map((c) => ({
              ...c,
              score: combinedSimilarity(params.name, c.name, 0.6, FUZZY_THRESHOLD),
            }))
            .filter((c) => c.score >= FUZZY_THRESHOLD)
            .sort((a, b) => b.score - a.score);
          if (matches.length > 0 && !params.confirm_create_new) {
            return {
              content: [
                jsonContent({
                  success: false,
                  needs_confirmation: true,
                  message:
                    "Likely-duplicate performer(s) found. Re-call with performer_id to link one, or confirm_create_new=true to create a new act.",
                  matches: matches.map((m) => ({
                    id: m.id,
                    name: m.name,
                    slug: m.slug,
                    score: Number(m.score.toFixed(3)),
                  })),
                }),
              ],
            };
          }
          const slug = await ensureUniquePerformerSlug(db, params.name);
          const now = new Date();
          const created = await db
            .insert(performers)
            .values({
              name: params.name,
              slug: unsafeSlug(slug),
              ...performerValues(params),
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          performerId = created[0].id;
          await logAction(db, auth, "performer.create", performerId, {
            name: params.name,
            via: "create_or_link_performer",
          });
        }

        const appearance = await linkAppearance(db, {
          eventId: params.event_id,
          performerId,
          eventDayId: params.event_day_id ?? null,
          performanceStart: toDate(params.performance_start),
          performanceEnd: toDate(params.performance_end),
          stage: params.stage ?? null,
          billing: params.billing ?? null,
          status: params.status ?? "PENDING",
          sourceUrl: params.source_url,
        });
        await logAction(db, auth, "performer.link", performerId, {
          event_id: params.event_id,
          appearance_id: appearance.row.id,
          created: appearance.created,
        });
        return {
          content: [
            jsonContent({
              success: true,
              created_appearance: appearance.created,
              appearance: appearanceOut(appearance.row),
            }),
          ],
        };
      } catch (e) {
        return err("create_or_link_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── link_performer_to_event ───────────────────────────────────────
  server.tool(
    "link_performer_to_event",
    "Record one appearance/set of a known performer at an event. Idempotent on (event, performer, day, start) — a repeat call for the same slot returns the existing appearance; a different slot creates a new one. Stores source_url (provenance). Admin only.",
    {
      event_id: z.string().min(1),
      performer_id: z.string().min(1),
      event_day_id: z.string().optional(),
      performance_start: z.number().int().optional().describe("epoch seconds"),
      performance_end: z.number().int().optional().describe("epoch seconds"),
      stage: z.string().optional(),
      billing: z.enum(BILLING).optional(),
      status: z.enum(APPEARANCE_STATUS).optional().describe("Default PENDING."),
      source_url: z.string().describe("Provenance (required)."),
    },
    async (params) => {
      try {
        const appearance = await linkAppearance(db, {
          eventId: params.event_id,
          performerId: params.performer_id,
          eventDayId: params.event_day_id ?? null,
          performanceStart: toDate(params.performance_start),
          performanceEnd: toDate(params.performance_end),
          stage: params.stage ?? null,
          billing: params.billing ?? null,
          status: params.status ?? "PENDING",
          sourceUrl: params.source_url,
        });
        await logAction(db, auth, "performer.link", params.performer_id, {
          event_id: params.event_id,
          appearance_id: appearance.row.id,
          created: appearance.created,
        });
        return {
          content: [
            jsonContent({
              success: true,
              created_appearance: appearance.created,
              appearance: appearanceOut(appearance.row),
            }),
          ],
        };
      } catch (e) {
        return err("link_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── unlink_performer_from_event ───────────────────────────────────
  server.tool(
    "unlink_performer_from_event",
    "Remove one appearance by its event_performers id. Admin only.",
    { event_performer_id: z.string().min(1) },
    async (params) => {
      try {
        const rows = await db
          .delete(eventPerformers)
          .where(eq(eventPerformers.id, params.event_performer_id))
          .returning();
        if (rows.length === 0)
          return err("not_found", `No appearance ${params.event_performer_id}.`);
        await logAction(db, auth, "performer.unlink", rows[0].performerId, {
          appearance_id: rows[0].id,
          event_id: rows[0].eventId,
        });
        return { content: [jsonContent({ success: true, removed: appearanceOut(rows[0]) })] };
      } catch (e) {
        return err("unlink_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── set_event_performer_status ────────────────────────────────────
  server.tool(
    "set_event_performer_status",
    "Set an appearance's status (CONFIRMED/PENDING/CANCELLED). Only CONFIRMED is emitted to schema.org (Phase 2). Admin only.",
    {
      event_performer_id: z.string().min(1),
      status: z.enum(APPEARANCE_STATUS),
    },
    async (params) =>
      setAppearanceField(db, auth, params.event_performer_id, { status: params.status }, "status")
  );

  // ── set_event_performer_billing ───────────────────────────────────
  server.tool(
    "set_event_performer_billing",
    "Set an appearance's billing (HEADLINER/FEATURED/SUPPORTING) — controls display emphasis + emission order. Admin only.",
    {
      event_performer_id: z.string().min(1),
      billing: z.enum(BILLING),
    },
    async (params) =>
      setAppearanceField(
        db,
        auth,
        params.event_performer_id,
        { billing: params.billing },
        "billing"
      )
  );

  // ── set_event_performer_slot ──────────────────────────────────────
  server.tool(
    "set_event_performer_slot",
    "Set an appearance's slot: day, start/end time (epoch seconds), and/or stage. Only provided fields change. Admin only.",
    {
      event_performer_id: z.string().min(1),
      event_day_id: z.string().nullable().optional(),
      performance_start: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("epoch seconds, or null to clear"),
      performance_end: z.number().int().nullable().optional(),
      stage: z.string().nullable().optional(),
    },
    async (params) => {
      const values: Record<string, unknown> = {};
      if (params.event_day_id !== undefined) values.eventDayId = params.event_day_id;
      if (params.performance_start !== undefined)
        values.performanceStart = toDate(params.performance_start);
      if (params.performance_end !== undefined)
        values.performanceEnd = toDate(params.performance_end);
      if (params.stage !== undefined) values.stage = params.stage;
      if (Object.keys(values).length === 0) return err("no_fields", "No slot fields to update.");
      return setAppearanceField(db, auth, params.event_performer_id, values, "slot");
    }
  );

  // ── list_event_performers ─────────────────────────────────────────
  server.tool(
    "list_event_performers",
    "List all appearances at an event, joined with performer name/slug, ordered by billing then start time. Call this FIRST before bulk-linking (roster-check). Admin only.",
    { event_id: z.string().min(1) },
    async (params) => {
      try {
        const rows = await db
          .select({
            appearance: eventPerformers,
            name: performers.name,
            slug: performers.slug,
          })
          .from(eventPerformers)
          .innerJoin(performers, eq(eventPerformers.performerId, performers.id))
          .where(eq(eventPerformers.eventId, params.event_id))
          .orderBy(desc(eventPerformers.performanceStart));
        const billingRank: Record<string, number> = { HEADLINER: 0, FEATURED: 1, SUPPORTING: 2 };
        const out = rows
          .map((r) => ({
            ...appearanceOut(r.appearance),
            performer_name: r.name,
            performer_slug: r.slug,
          }))
          .sort(
            (a, b) =>
              (billingRank[a.billing ?? ""] ?? 3) - (billingRank[b.billing ?? ""] ?? 3) ||
              (a.performance_start ?? 0) - (b.performance_start ?? 0)
          );
        return {
          content: [
            jsonContent({
              success: true,
              event_id: params.event_id,
              count: out.length,
              appearances: out,
            }),
          ],
        };
      } catch (e) {
        return err("list_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── set_performer_alias ───────────────────────────────────────────
  server.tool(
    "set_performer_alias",
    "Mark one performer as an ALIAS of another ('this row IS that act, different spelling'). Sets alias_of + redirect_to on the alias, soft-deletes it, and renames its slug so the canonical is free. Does NOT move appearances — use merge_performer for that. Admin only.",
    {
      alias_performer_id: z.string().min(1).describe("The duplicate/mis-spelled row."),
      canonical_performer_id: z.string().min(1).describe("The row to keep as canonical."),
    },
    async (params) => {
      try {
        if (params.alias_performer_id === params.canonical_performer_id)
          return err("self_alias", "alias and canonical must differ.");
        const [alias] = await db
          .select()
          .from(performers)
          .where(eq(performers.id, params.alias_performer_id))
          .limit(1);
        const [canonical] = await db
          .select({ id: performers.id, slug: performers.slug })
          .from(performers)
          .where(eq(performers.id, params.canonical_performer_id))
          .limit(1);
        if (!alias) return err("not_found", `No performer ${params.alias_performer_id}.`);
        if (!canonical) return err("not_found", `No performer ${params.canonical_performer_id}.`);
        const now = new Date();
        const tombstoneSlug = unsafeSlug(`${alias.slug}-alias-${alias.id.slice(0, 8)}`);
        // slug-history newSlug = the live CANONICAL slug (not the tombstone) so the
        // middleware 301s the alias's old slug to the canonical page (OPE-115 fix).
        await db.insert(performerSlugHistory).values({
          performerId: params.canonical_performer_id,
          oldSlug: alias.slug,
          newSlug: canonical.slug,
          changedAt: now,
          changedBy: auth.userId ?? null,
        });
        await db
          .update(performers)
          .set({
            aliasOfPerformerId: params.canonical_performer_id,
            redirectToPerformerId: params.canonical_performer_id,
            deletedAt: now,
            slug: tombstoneSlug,
            updatedAt: now,
          })
          .where(eq(performers.id, params.alias_performer_id));
        await logAction(db, auth, "performer.alias", params.alias_performer_id, {
          canonical: params.canonical_performer_id,
        });
        return {
          content: [jsonContent({ success: true, alias_of: params.canonical_performer_id })],
        };
      } catch (e) {
        return err("alias_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );

  // ── merge_performer ───────────────────────────────────────────────
  server.tool(
    "merge_performer",
    "Merge a duplicate performer into a keeper: moves the duplicate's appearances to the keeper (dropping exact-duplicate slots), writes a performer_slug_history row so the old slug 301-redirects, gap-fills empty keeper fields from the duplicate, then tombstones the duplicate (soft-delete + slug rename + redirect_to keeper). Refuses self-merge. Admin only.",
    {
      keeper_performer_id: z.string().min(1),
      duplicate_performer_id: z.string().min(1),
    },
    async (params) => {
      try {
        if (params.keeper_performer_id === params.duplicate_performer_id)
          return err("self_merge", "keeper and duplicate must differ.");
        const [keeper] = await db
          .select()
          .from(performers)
          .where(eq(performers.id, params.keeper_performer_id))
          .limit(1);
        const [dup] = await db
          .select()
          .from(performers)
          .where(eq(performers.id, params.duplicate_performer_id))
          .limit(1);
        if (!keeper) return err("not_found", `No keeper ${params.keeper_performer_id}.`);
        if (!dup) return err("not_found", `No duplicate ${params.duplicate_performer_id}.`);

        // Move appearances, dropping any that would collide with a keeper slot.
        const dupAppearances = await db
          .select()
          .from(eventPerformers)
          .where(eq(eventPerformers.performerId, params.duplicate_performer_id));
        let moved = 0;
        let dropped = 0;
        for (const a of dupAppearances) {
          const clash = await db
            .select({ id: eventPerformers.id })
            .from(eventPerformers)
            .where(
              appearanceWhere(
                a.eventId,
                params.keeper_performer_id,
                a.eventDayId,
                a.performanceStart
              )
            )
            .limit(1);
          if (clash.length > 0) {
            await db.delete(eventPerformers).where(eq(eventPerformers.id, a.id));
            dropped++;
          } else {
            await db
              .update(eventPerformers)
              .set({ performerId: params.keeper_performer_id, updatedAt: new Date() })
              .where(eq(eventPerformers.id, a.id));
            moved++;
          }
        }

        // Gap-fill empty keeper fields from the duplicate.
        const gap: Record<string, unknown> = {};
        const keeperRec = keeper as unknown as Record<string, unknown>;
        const dupRec = dup as unknown as Record<string, unknown>;
        for (const col of [
          "description",
          "website",
          "socialLinks",
          "imageUrl",
          "homeBaseCity",
          "homeBaseState",
          "contactName",
          "contactEmail",
          "contactPhone",
          "performerType",
          "actCategory",
        ]) {
          if ((keeperRec[col] == null || keeperRec[col] === "") && dupRec[col] != null)
            gap[col] = dupRec[col];
        }
        if (Object.keys(gap).length > 0) {
          gap.updatedAt = new Date();
          await db.update(performers).set(gap).where(eq(performers.id, params.keeper_performer_id));
        }

        const now = new Date();
        const tombstoneSlug = unsafeSlug(`${dup.slug}-merged-${dup.id.slice(0, 8)}`);
        // slug-history newSlug = the live KEEPER slug (not the tombstone) so the
        // middleware 301s the duplicate's old slug to the keeper page (OPE-115 fix).
        await db.insert(performerSlugHistory).values({
          performerId: params.keeper_performer_id,
          oldSlug: dup.slug,
          newSlug: keeper.slug,
          changedAt: now,
          changedBy: auth.userId ?? null,
        });
        await db
          .update(performers)
          .set({
            deletedAt: now,
            redirectToPerformerId: params.keeper_performer_id,
            aliasOfPerformerId: params.keeper_performer_id,
            slug: tombstoneSlug,
            updatedAt: now,
          })
          .where(eq(performers.id, params.duplicate_performer_id));
        await logAction(db, auth, "performer.merge", params.keeper_performer_id, {
          duplicate: params.duplicate_performer_id,
          appearances_moved: moved,
          appearances_dropped: dropped,
          gap_filled: Object.keys(gap).filter((k) => k !== "updatedAt"),
        });
        return {
          content: [
            jsonContent({
              success: true,
              keeper_performer_id: params.keeper_performer_id,
              appearances_moved: moved,
              appearances_dropped: dropped,
            }),
          ],
        };
      } catch (e) {
        return err("merge_failed", e instanceof Error ? e.message : String(e));
      }
    }
  );
}

/** Insert or return an existing appearance for the identity. Idempotent on the
 *  (event, performer, day, start) key — incl. the NULL-start case the UNIQUE
 *  index can't enforce (OPE-112 note). */
async function linkAppearance(
  db: Db,
  a: {
    eventId: string;
    performerId: string;
    eventDayId: string | null;
    performanceStart: Date | null;
    performanceEnd: Date | null;
    stage: string | null;
    billing: (typeof BILLING)[number] | null;
    status: (typeof APPEARANCE_STATUS)[number];
    sourceUrl: string;
  }
): Promise<{ row: typeof eventPerformers.$inferSelect; created: boolean }> {
  const existing = await db
    .select()
    .from(eventPerformers)
    .where(appearanceWhere(a.eventId, a.performerId, a.eventDayId, a.performanceStart))
    .limit(1);
  if (existing.length > 0) return { row: existing[0], created: false };
  const now = new Date();
  const rows = await db
    .insert(eventPerformers)
    .values({
      eventId: a.eventId,
      performerId: a.performerId,
      eventDayId: a.eventDayId,
      performanceStart: a.performanceStart,
      performanceEnd: a.performanceEnd,
      stage: a.stage,
      billing: a.billing,
      status: a.status,
      sourceUrl: a.sourceUrl,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { row: rows[0], created: true };
}

/** Shared setter for the appearance field tools. */
async function setAppearanceField(
  db: Db,
  auth: AuthContext,
  eventPerformerId: string,
  values: Record<string, unknown>,
  what: string
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  try {
    values.updatedAt = new Date();
    const rows = await db
      .update(eventPerformers)
      .set(values)
      .where(eq(eventPerformers.id, eventPerformerId))
      .returning();
    if (rows.length === 0) return err("not_found", `No appearance ${eventPerformerId}.`);
    await db.insert(adminActions).values({
      action: `performer.appearance.${what}`,
      actorUserId: auth.userId,
      targetType: "event_performer",
      targetId: rows[0].id,
      payloadJson: JSON.stringify({ fields: Object.keys(values).filter((k) => k !== "updatedAt") }),
      createdAt: new Date(),
    });
    return { content: [jsonContent({ success: true, appearance: appearanceOut(rows[0]) })] };
  } catch (e) {
    return err("update_failed", e instanceof Error ? e.message : String(e));
  }
}
