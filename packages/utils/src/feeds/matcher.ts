/**
 * OPE-1635 — the feed matcher's pure half: does a feed item name the same
 * event as one of the promoter's listings on the same start date?
 *
 * Extracted unchanged from mcp-server `feeds/ingest.ts` `linkItem` (OPE-1613)
 * so the ingest and `backtest_feed_rules` run the SAME predicate. A backtest
 * that re-implemented it would agree with the ingest until the day it did not.
 *
 * The ingest tries, in order: the item's prior link, an exact `source_url`
 * match, then this date + name match. Only the last one has settings to tune,
 * so it is the only one a backtest replays.
 */
import { createSlug } from "../index";

export interface FeedMatcherSettings {
  /** A name key shorter than this never matches (stops "Show" matching everything). */
  minNameKeyLength: number;
}

export const DEFAULT_MATCHER_SETTINGS: FeedMatcherSettings = { minNameKeyLength: 6 };

/** A comparison key, not a stored slug: createSlug (#120) with the hyphens dropped. */
export const feedNameKey = (s: string) => createSlug(s).replace(/-/g, "");

export interface MatchCandidate {
  id: string;
  name: string;
  /** The listing's start date, YYYY-MM-DD (UTC date of `events.start_date`). */
  startDate: string | null;
}

/**
 * The candidates a date + name match would link the item to. The ingest links
 * only when exactly ONE comes back; two or more stay for review.
 */
export function dateNameMatches(
  item: { title: string; startDate: string | null },
  candidates: MatchCandidate[],
  settings: FeedMatcherSettings = DEFAULT_MATCHER_SETTINGS,
  /** The event a reviewer unlinked this item from — never matched again (OPE-1634). */
  excludeEventId: string | null = null
): MatchCandidate[] {
  if (!item.startDate) return [];
  const key = feedNameKey(item.title);
  if (key.length < settings.minNameKeyLength) return [];
  return candidates.filter((c) => {
    if (c.id === excludeEventId || c.startDate !== item.startDate) return false;
    const ck = feedNameKey(c.name);
    return ck.includes(key) || key.includes(ck);
  });
}

/** The one event an unambiguous date + name match links to, or null. */
export function dateNameMatch(
  item: { title: string; startDate: string | null },
  candidates: MatchCandidate[],
  settings: FeedMatcherSettings = DEFAULT_MATCHER_SETTINGS,
  excludeEventId: string | null = null
): string | null {
  const hits = dateNameMatches(item, candidates, settings, excludeEventId);
  return hits.length === 1 ? hits[0].id : null;
}
