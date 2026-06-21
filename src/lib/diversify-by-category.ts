/**
 * Re-rank a start-date-ordered pool of events so a small grid shows a VARIETY
 * of event types instead of, e.g., four farmers markets in a row.
 *
 * Primary category is `categories[0]` — the same value StubEventCard renders as
 * the type chip. Two passes:
 *   1. take at most one event per category (soonest within each), then
 *   2. backfill by soonest when too few categories exist to fill the grid.
 *
 * Input order is assumed to be the desired tiebreak (typically start date
 * ascending); the helper preserves it within each pass. Degrades to pure
 * input order when there's only one type.
 */
import { parseJsonArray } from "@/types";

export function diversifyByCategory<T extends { categories?: string | null }>(
  pool: T[],
  limit: number
): T[] {
  const primaryCategory = (e: T) => parseJsonArray(e.categories ?? "")[0] ?? "Event";
  const picked: T[] = [];
  const seenCategories = new Set<string>();
  for (const e of pool) {
    if (picked.length >= limit) break;
    const cat = primaryCategory(e);
    if (!seenCategories.has(cat)) {
      seenCategories.add(cat);
      picked.push(e);
    }
  }
  if (picked.length < limit) {
    const used = new Set(picked);
    for (const e of pool) {
      if (picked.length >= limit) break;
      if (!used.has(e)) picked.push(e);
    }
  }
  return picked;
}
