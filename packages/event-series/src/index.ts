/**
 * Series parentage at write time — the single implementation, shared by the
 * Next.js app and the MCP Worker.
 *
 * ── Why this is a package and not an app module (OPE-472 rework) ──────────
 *
 * It shipped inside `src/lib/series/` and was therefore reachable only from
 * the app. The MCP Worker is a separate build, so `update_event` — the tool
 * that assigns a venue to an event that did not have one — could not call it.
 * That left a real hole: an event born venue-less stayed unparented forever,
 * because the only moment parentage was attempted had already passed.
 *
 * Duplicating the resolver on the MCP side would have been the faster move and
 * the wrong one; this project has been bitten before by a fix wired into one
 * of two parallel paths. One implementation, two importers.
 *
 * ── The grouping key ─────────────────────────────────────────────────────
 *
 * `normalized(name) + venue_id`, per
 * `MMATF-EventOccurrence-Model-Redesign-2026-06-21.md`. The older grouper keys
 * on slug-stem instead, and OPE-473 was the bill for that: 123 duplicate
 * parents splitting recurring fairs across two indexed hubs each.
 *
 * The specified key is only viable because OPE-197 evergreened the names.
 * Before that, "Cheshire Fair 2026" and "Cheshire Fair 2027" normalized apart
 * and this key would have minted exactly the duplication it prevents.
 *
 * ── What it deliberately does not do ─────────────────────────────────────
 *
 * It never merges or renames an existing series, and it never attaches an
 * event to a parent at a different venue. Two fairs sharing a name in two
 * towns are two series; conflating them silently folds two towns' events into
 * one hub, which is worse than leaving one unparented.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import { events, eventSeries } from "@takemetothefair/db-schema";
import { createSlug, appendSlugSegment } from "@takemetothefair/utils";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Strip a trailing edition token from a series/event DISPLAY name — a year or
 * full date, with an optional dash separator (hyphen / en-dash / em-dash). A
 * *series* spans editions, so its name must not carry one occurrence's date.
 * Preserves case + punctuation (unlike `normalizeName`, which lower-cases for
 * dedup matching). Returns the original if stripping would leave an empty name.
 *
 *   Fryeburg Fair 2026                              → Fryeburg Fair
 *   Burlington Summer Farmers Market — 2026-09-19   → Burlington Summer Farmers Market
 *   Newport Boat Show / Route 66 Rally              → unchanged
 */
export function stripNameEditionSuffix(name: string): string {
  const stripped = name.replace(/\s*[—–-]?\s*(?:19|20)\d\d(?:-\d\d){0,2}\s*$/, "").trim();
  return stripped || name;
}

/**
 * The grouping key. Case- and punctuation-insensitive on the edition-stripped
 * name, so "Cheshire Fair", "cheshire fair" and "Cheshire Fair 2027" all land
 * on one parent.
 */
export function seriesNameKey(name: string): string {
  return stripNameEditionSuffix(name || "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ResolveSeriesInput {
  name: string;
  venueId: string | null | undefined;
  promoterId?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  categories?: string | null;
  tags?: string | null;
}

/**
 * Why `skipped` carries a `reason`, and why callers must surface it.
 *
 * The first review of OPE-472 read a WORKING write path as a dead one, because
 * the only number reported was a total orphan count and that count kept
 * growing. It grew for a legitimate reason — venue-less events are skipped by
 * design — but "skipped deliberately" and "never ran" were indistinguishable
 * from outside. A fail-soft reason that nothing reads is not an explanation.
 */
export type SeriesSkipReason =
  | "no usable name"
  | "no venue"
  | "series resolve failed"
  | "attach failed";

export interface ResolveSeriesResult {
  seriesId: string | null;
  /** `matched` — joined an existing parent. `created` — minted one.
   *  `skipped` — deliberately unparented; see `reason`. */
  outcome: "matched" | "created" | "skipped";
  reason?: SeriesSkipReason;
}

/**
 * Find the series this event belongs to, creating it if it is the first of its
 * kind. Returns `skipped` rather than throwing when there is nothing safe to
 * key on.
 *
 * Best-effort by contract: a failure here must never fail the event insert.
 * An unparented event is a degraded event; a lost event is a lost submission.
 */
export async function resolveOrCreateSeries(
  db: Db,
  input: ResolveSeriesInput
): Promise<ResolveSeriesResult> {
  const key = seriesNameKey(input.name);
  // No name, or no venue, means no safe key. Grouping on name alone would put
  // every "Holiday Craft Fair" in New England under one parent.
  if (!key) return { seriesId: null, outcome: "skipped", reason: "no usable name" };
  if (!input.venueId) return { seriesId: null, outcome: "skipped", reason: "no venue" };

  try {
    // Match on the normalized name at the SAME venue.
    const candidates = await db
      .select({ id: eventSeries.id, name: eventSeries.name })
      .from(eventSeries)
      .where(eq(eventSeries.venueId, input.venueId));

    const hit = candidates.find((c) => seriesNameKey(c.name) === key);
    if (hit) return { seriesId: hit.id, outcome: "matched" };

    // First edition of this fair at this venue — mint the parent.
    const seriesName = stripNameEditionSuffix(input.name);
    const base = createSlug(seriesName);
    let canonicalSlug = base;
    const clash = await db
      .select({ id: eventSeries.id })
      .from(eventSeries)
      .where(eq(eventSeries.canonicalSlug, canonicalSlug))
      .limit(1);
    if (clash.length > 0) {
      // Same name, different venue. A suffixed slug keeps both reachable
      // rather than letting one silently win the URL.
      canonicalSlug = appendSlugSegment(base, input.venueId.slice(0, 8));
    }

    const seriesId = crypto.randomUUID();
    const now = new Date();
    await db.insert(eventSeries).values({
      id: seriesId,
      canonicalSlug,
      name: seriesName,
      venueId: input.venueId,
      promoterId: input.promoterId ?? null,
      recurrenceRule: null,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      categories: input.categories ?? "[]",
      tags: input.tags ?? "[]",
      createdAt: now,
      updatedAt: now,
    });
    return { seriesId, outcome: "created" };
  } catch {
    // Never fail the event insert over its parent.
    return { seriesId: null, outcome: "skipped", reason: "series resolve failed" };
  }
}

/**
 * Attach an already-created event to its series, best-effort.
 *
 * Separate from `resolveOrCreateSeries` so a caller that inserts the event
 * first (most of them) can stay a single statement, then attach. The event is
 * already durable by the time this runs, which is the right order: the parent
 * is an enhancement, the event is the submission.
 *
 * The `isNull(seriesId)` guard makes this idempotent and safe to call from a
 * late path — it can only fill a hole, never re-parent an event that already
 * belongs somewhere.
 */
export async function attachEventToSeries(
  db: Db,
  eventId: string,
  input: ResolveSeriesInput
): Promise<ResolveSeriesResult> {
  const res = await resolveOrCreateSeries(db, input);
  if (!res.seriesId) return res;
  try {
    await db
      .update(events)
      .set({ seriesId: res.seriesId })
      .where(and(eq(events.id, eventId), isNull(events.seriesId)));
  } catch {
    return { seriesId: null, outcome: "skipped", reason: "attach failed" };
  }
  return res;
}

/** Live events with no parent — OPE-472's `series_orphan_event` invariant. */
export function orphanEventCondition() {
  return sql`series_id IS NULL AND status IN ('APPROVED','TENTATIVE') AND merged_into IS NULL`;
}
