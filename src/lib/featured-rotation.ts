/**
 * Daily-rotating fair shuffle for the Featured Vendors section.
 *
 * Deterministic so all visitors see the same order on a given UTC date.
 * The order changes once per UTC day. Pin override: any vendor with
 * featured_priority > 0 is sorted ABOVE the rotated list, descending by
 * priority — used for boosting specific vendors temporarily.
 */

export interface FeaturedItem {
  id: string;
  featuredPriority?: number | null;
}

/**
 * Public API: takes the full list of featured-eligible items, returns up
 * to `topN` items with pinned items first, then daily-rotated items.
 */
export function rotateFeaturedVendors<T extends FeaturedItem>(
  items: readonly T[],
  options: { topN?: number; date?: Date } = {}
): T[] {
  const { topN = 6, date = new Date() } = options;
  const utcDay = Math.floor(date.getTime() / 86400000);

  // Day-mixed sort key: hash the id stably, then XOR with the UTC day.
  // Naively concatenating the day into the hashed string didn't work —
  // djb2 keeps the suffix-impact small when most of the input is the same
  // day prefix, so all ids ended up sorted nearly identically every day.
  // XOR'ing post-hash gives meaningful per-day reshuffling.
  const dayKey = (id: string) => (hashStr(id) ^ utcDay) >>> 0;

  // Pinned: featured_priority > 0, descending. Ties broken by daily shuffle
  // so two equal-priority pins don't always sort the same way.
  const pinned = items
    .filter((v) => (v.featuredPriority ?? 0) > 0)
    .slice()
    .sort((a, b) => {
      const pa = a.featuredPriority ?? 0;
      const pb = b.featuredPriority ?? 0;
      if (pa !== pb) return pb - pa;
      return dayKey(a.id) - dayKey(b.id);
    });

  const shuffled = items
    .filter((v) => (v.featuredPriority ?? 0) === 0)
    .slice()
    .sort((a, b) => dayKey(a.id) - dayKey(b.id));

  return [...pinned, ...shuffled].slice(0, topN);
}

/**
 * Stable string hash. Not cryptographic; we only need it to be deterministic
 * across machines and roughly uniform for shuffling. djb2-style.
 */
export function hashStr(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
