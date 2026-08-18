/**
 * OPE-472 — MCP twin of `src/lib/series/resolve-or-create-series.ts`.
 *
 * `event_series` has minted nothing since 2026-06-30, and 170 of the 172
 * events created since 2026-07-01 were born with `series_id` NULL, because the
 * only `insert(eventSeries)` in the repo is the admin backfill route. MCP's
 * `suggest_event` is one of the paths producing those rows, and app and MCP are
 * separate builds, so the attach has to exist on both sides.
 *
 * Kept deliberately small and identical in behaviour to its twin:
 *
 *   - key on normalized(name) + venue_id, per the redesign spec — NOT
 *     slug-stem, which is what produced OPE-473's 126 duplicate parents;
 *   - never attach across venues: two fairs sharing a name at different venues
 *     are different series, and merging them would fold two towns' events into
 *     one hub;
 *   - never fail the event insert. An unparented event is degraded; a lost
 *     event is a lost submission.
 */
import { and, eq, isNull } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { events, eventSeries } from "../schema.js";
import type { Db } from "../db.js";

/** Strip a trailing edition marker so every year of a fair keys the same.
 *
 *  A local copy rather than an import: `stripNameEditionSuffix` lives in the
 *  app's `src/lib/series/group-events.ts`, which MCP cannot reach across the
 *  build boundary. Kept minimal on purpose — it handles the shapes our series
 *  names actually carry now that OPE-197 has evergreened them (verified: zero
 *  series names retain a trailing year). */
function stripEdition(name: string): string {
  return (name || "")
    .replace(/\s*[—–-]\s*\d{4}-\d{2}-\d{2}\s*$/, "")
    .replace(/\s*[—–-]?\s*(19|20)\d{2}\s*$/, "")
    .trim();
}

export function seriesNameKey(name: string): string {
  return stripEdition(name).toLowerCase().replace(/['’.]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Attach a just-created event to its series, minting the parent when this is
 * the first edition at that venue. Best-effort throughout.
 */
export async function attachEventToSeries(
  db: Db,
  eventId: string,
  input: { name: string; venueId: string | null | undefined; promoterId?: string | null }
): Promise<"matched" | "created" | "skipped"> {
  const key = seriesNameKey(input.name);
  // Grouping on name alone would put every "Holiday Craft Fair" in New England
  // under one parent, so both halves of the key are required.
  if (!key || !input.venueId) return "skipped";

  try {
    const candidates = await db
      .select({ id: eventSeries.id, name: eventSeries.name })
      .from(eventSeries)
      .where(eq(eventSeries.venueId, input.venueId));

    let seriesId = candidates.find((c) => seriesNameKey(c.name) === key)?.id;
    const outcome: "matched" | "created" = seriesId ? "matched" : "created";

    if (!seriesId) {
      const seriesName = stripEdition(input.name);
      const base = seriesName
        .toLowerCase()
        // eslint-disable-next-line no-restricted-syntax -- a series canonical_slug, built to match the app-side createSlug output shape; the canonical helper is TypeScript in a workspace package the MCP build cannot import.
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const clash = await db
        .select({ id: eventSeries.id })
        .from(eventSeries)
        // Boundary cast: `base` is built here rather than by createSlug,
        // which the MCP build cannot import. Explicit per the #120 discipline.
        .where(eq(eventSeries.canonicalSlug, unsafeSlug(base)))
        .limit(1);
      // Same name at a different venue — suffix rather than let one silently
      // win the URL.
      const canonicalSlug = clash.length > 0 ? `${base}-${input.venueId.slice(0, 8)}` : base;

      seriesId = crypto.randomUUID();
      const now = new Date();
      await db.insert(eventSeries).values({
        id: seriesId,
        canonicalSlug: unsafeSlug(canonicalSlug),
        name: seriesName,
        venueId: input.venueId,
        promoterId: input.promoterId ?? null,
        categories: "[]",
        tags: "[]",
        createdAt: now,
        updatedAt: now,
      } as typeof eventSeries.$inferInsert);
    }

    await db
      .update(events)
      .set({ seriesId })
      .where(and(eq(events.id, eventId), isNull(events.seriesId)));
    return outcome;
  } catch {
    return "skipped";
  }
}
