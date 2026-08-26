"use client";

import { useEffect, useRef } from "react";
import { trackSearchResults } from "@/lib/analytics";

interface SearchResultsTrackerProps {
  /** The query the user actually searched for. */
  query: string;
  /** Number of results this page rendered — 0 is the important case. */
  resultsCount: number;
  /**
   * OPE-549 — true when at least one search section FAILED rather than
   * returning nothing. Suppresses the event entirely.
   *
   * Not a smaller count, and not a flag on the event: a count from an
   * incomplete search is not a count. This tracker exists (OPE-248) precisely
   * so a zero is trustworthy — "zero-result queries are the ones telling us
   * what inventory or aliasing we're missing" — and a section that threw
   * produces a zero that means the opposite. Emitting it would poison the one
   * metric this component was built to provide.
   */
  incomplete?: boolean;
}

/**
 * OPE-248 — fires `view_search_results` WITH `results_count` from the /search
 * results page.
 *
 * Why this exists: `/search/page.tsx` is a Server Component, so it can't call
 * the client-side tracker. The result was that the /search page emitted no
 * event of our own — and GA4's Enhanced Measurement "site search" auto-fires
 * `view_search_results` for any URL carrying `?q=`, WITHOUT `results_count`.
 * So the same event name had two producers: the GlobalSearch dropdown (with a
 * count) and Google's auto-event (without). That's why 13 of the top 15
 * queries reported `results_count: null` — the count wasn't missing, the
 * events were coming from a producer that never had it.
 *
 * Firing our own event here means every /search view carries a count,
 * including **0** — which is the entire point, since zero-result queries are
 * the ones telling us what inventory or aliasing we're missing.
 *
 * Mirrors DetailPageTracker: a null-rendering client component dropped into a
 * Server Component page.
 */
export function SearchResultsTracker({
  query,
  resultsCount,
  incomplete = false,
}: SearchResultsTrackerProps) {
  // Guard against React Strict Mode's double-invoke in dev and against a
  // re-render re-emitting for the same query. Keyed by query+count so a NEW
  // search on the same mounted page still emits.
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    // OPE-549 — an incomplete search reports nothing at all.
    if (incomplete) return;
    const key = `${query}::${resultsCount}`;
    if (lastSent.current === key) return;
    lastSent.current = key;
    trackSearchResults(query, resultsCount);
  }, [query, resultsCount, incomplete]);

  return null;
}
