/**
 * OPE-472 — give every new event a series parent at write time.
 *
 * `event_series` was backfilled once and has been inert since. Measured
 * 2026-08-18: the newest series row was created **2026-06-30**, 49 days
 * earlier, and **170 of the 172 events created since 2026-07-01 have
 * `series_id` NULL**.
 *
 * The cause is structural rather than a bug in any one path: the only
 * `insert(eventSeries)` in the repo is `api/admin/series/backfill/route.ts`.
 * `create-occurrence.ts` inserts occurrence *events* under an **existing**
 * `seriesId`. So every other path — public `/suggest-event`, the inbound
 * submit@ pipeline, scraper and aggregator import, admin create — mints an
 * event that is permanently unparented unless a human re-runs the backfill.
 *
 * An unparented event has no series hub, so it is invisible to the evergreen
 * landing model the whole Option-A URL scheme rests on, and unreachable from
 * any sibling edition.
 *
 * ── The grouping key, and why it is not the shipped one ──────────────────
 *
 * `normalized(name) + venue_id`, which is what
 * `MMATF-EventOccurrence-Model-Redesign-2026-06-21.md` specifies. The shipped
 * grouper keys on **slug-stem** instead, and OPE-473 is the bill for that: 126
 * duplicate parents splitting 99 recurring fairs across two indexed hubs each.
 *
 * The specified key is only viable now because OPE-197 evergreened the names —
 * verified: zero series names carry a trailing year. Before that, "Cheshire
 * Fair 2026" and "Cheshire Fair 2027" would have normalized apart and this key
 * would have produced exactly the duplication it prevents.
 *
 * ── What this deliberately does not do ───────────────────────────────────
 *
 * It never merges or renames an existing series, and it never attaches an
 * event to a parent whose venue differs. Two fairs sharing a name at different
 * venues are different series; conflating them would silently merge two towns'
 * events into one hub, which is worse than leaving one unparented.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events, eventSeries } from "@/lib/db/schema";
import { stripNameEditionSuffix } from "@/lib/series/group-events";
import { createSlug, appendSlugSegment } from "@/lib/utils";

type Db = DrizzleD1Database<typeof schema>;

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

export interface ResolveSeriesResult {
  seriesId: string | null;
  /** `matched` — joined an existing parent. `created` — minted one.
   *  `skipped` — deliberately unparented; see `reason`. */
  outcome: "matched" | "created" | "skipped";
  reason?: string;
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
    // Match on the normalized name at the SAME venue. Compared in SQL so the
    // read is one indexed query rather than a table scan in memory.
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
