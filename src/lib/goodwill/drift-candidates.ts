/**
 * OPE-814 — what the drift sweep should fetch, and how to compare it.
 *
 * ## The targeting problem
 *
 * `stale_page_radar` has touched **6 domains in its entire history**; 542 of its
 * 561 all-time rows are three aggregator feeds, and it covers **1 of the 136
 * promoter-own domains** where a stale-prior-year finding is both true about
 * the organizer and safe to raise with them.
 *
 * That is not a list anybody configured. The sweep selected
 * `status='APPROVED' AND start_date BETWEEN now+30d AND now+90d`, and fetched
 * whatever `source_url` those events happened to carry. Three aggregators
 * dominate because they are the `source_url` on many events at once.
 *
 * Two consequences follow from the query, not from anyone's intent:
 *
 *   - **The forward window is a gate.** A recurring market with weekly
 *     occurrences has most of them outside any 60-day slice at any moment —
 *     the `[[seasonal-markets-break-forward-gates]]` shape, already live.
 *   - **TENTATIVE was excluded**, though a tentative date is exactly the kind
 *     most worth checking against the organizer's own page.
 *
 * ## The unit of work is the URL, not the event
 *
 * 242 upcoming promoter-own-domain events resolve to **135 distinct URLs**
 * (measured 2026-09-06; the ticket saw 241/133 a day earlier). The tail is
 * heavy: `vtfarmersmarket.org` is 36 events pointing at one page.
 *
 * The old loop was `for (const ev of candidates) fetchCanonicalDate(ev.sourceUrl)`
 * — per event, no dedup. That is 36 fetches and 36 rows for one fact.
 *
 * ## ⚠️ Why a multi-event URL needs set comparison, not a representative event
 *
 * Once you fetch per URL, "which of the 36 dates does the page's date disagree
 * with?" has no honest answer. Picking one arbitrarily manufactures the exact
 * defect OPE-815 scope 6 describes: four `capecodchamber.org` rows that are one
 * recurring series matched to different occurrences, filed as an external date
 * conflict.
 *
 * So a page's date is compared against **the set** of dates we hold for that
 * URL. If it matches any of them, the page is consistent with our data and
 * there is nothing to report. Only a date matching none of ours is a finding.
 * That needs no occurrence identity and cannot invent the Truro rows.
 */

/** One page to fetch, with every date we hold behind it. */
export interface DriftCandidateUrl {
  sourceUrl: string;
  /** Every upcoming event on this URL. Times are ms-epoch. */
  events: Array<{ id: string; startDate: number }>;
  /** True when the URL is on the promoter's own domain. */
  promoterOwned: boolean;
}

export interface RawCandidateRow {
  eventId: string;
  sourceUrl: string | null;
  startDate: Date | null;
  promoterOwned: boolean;
}

/**
 * Collapse event rows into one entry per distinct URL.
 *
 * Rows with no URL or no date are dropped — there is nothing to fetch or to
 * compare. `promoterOwned` is true when ANY event on the URL is promoter-owned:
 * the flag describes the page, and a page on the organizer's own domain does
 * not stop being theirs because a second event also points at it.
 */
export function groupCandidatesByUrl(rows: RawCandidateRow[]): DriftCandidateUrl[] {
  const byUrl = new Map<string, DriftCandidateUrl>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.sourceUrl || !r.startDate) continue;
    const t = r.startDate.getTime();
    if (!Number.isFinite(t)) continue;
    const existing = byUrl.get(r.sourceUrl);
    if (existing) {
      existing.events.push({ id: r.eventId, startDate: t });
      existing.promoterOwned = existing.promoterOwned || r.promoterOwned;
    } else {
      byUrl.set(r.sourceUrl, {
        sourceUrl: r.sourceUrl,
        events: [{ id: r.eventId, startDate: t }],
        promoterOwned: r.promoterOwned,
      });
    }
  }
  // Promoter-owned pages first: they are the ones a finding can be raised with
  // the organizer about, and the per-run cap should spend on them first.
  return [...byUrl.values()].sort((a, b) => {
    if (a.promoterOwned !== b.promoterOwned) return a.promoterOwned ? -1 : 1;
    return a.sourceUrl.localeCompare(b.sourceUrl);
  });
}

const MS_PER_DAY = 86_400_000;

/**
 * Does the page's date disagree with EVERY date we hold for this URL?
 *
 * Returns the smallest drift in days against the closest of our dates, or
 * `null` when the page agrees with one of them (within the threshold).
 *
 * ⚠️ Closest, not first. A page listing one occurrence of a weekly market
 * agrees with our data; comparing it against an arbitrary sibling would report
 * a drift of exactly one week, forever, for every market we hold.
 */
export function driftAgainstAll(
  canonicalStartDate: Date | null,
  candidate: DriftCandidateUrl,
  thresholdDays: number
): number | null {
  if (!canonicalStartDate) return null;
  const page = canonicalStartDate.getTime();
  if (!Number.isFinite(page) || candidate.events.length === 0) return null;

  let smallest = Number.POSITIVE_INFINITY;
  for (const ev of candidate.events) {
    const drift = Math.abs(page - ev.startDate) / MS_PER_DAY;
    if (drift < smallest) smallest = drift;
  }
  const rounded = Math.round(smallest);
  return rounded > thresholdDays ? rounded : null;
}

/**
 * The event on this URL whose date is closest to the page's — the occurrence
 * the page most plausibly describes.
 *
 * Used to decide which event a finding is filed against, once one fetch covers
 * many events. Falls back to the first event when the page has no readable
 * date, which only happens on a path that files nothing.
 */
export function closestEvent(
  canonicalStartDate: Date | null,
  candidate: DriftCandidateUrl
): { id: string; startDate: number } {
  const first = candidate.events[0];
  if (!canonicalStartDate) return first;
  const page = canonicalStartDate.getTime();
  if (!Number.isFinite(page)) return first;
  let best = first;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const ev of candidate.events) {
    const gap = Math.abs(page - ev.startDate);
    if (gap < bestGap) {
      bestGap = gap;
      best = ev;
    }
  }
  return best;
}
