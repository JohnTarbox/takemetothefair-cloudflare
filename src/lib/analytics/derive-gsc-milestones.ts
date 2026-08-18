/**
 * OPE-456 scope 4 — derive click milestones from our OWN GSC data.
 *
 * A "12K clicks in 28 days" milestone is a threshold crossing on a time series
 * we already ingest (`gsc_daily_totals`, 198 days as of 2026-08-18). Using a
 * forwarded email as the system of record for it means a milestone is missed
 * whenever nobody checks an inbox, and its date is only as good as whatever the
 * ingest could parse.
 *
 * ── Validation, before trusting any of this ──────────────────────────────
 *
 * Rolling 28-day sums were computed over the stored dailies and compared
 * against every milestone a human had entered:
 *
 *     13 of 13 rows with a stored date MATCH the derived date, exactly,
 *     across five months and thresholds from 40 to 7,000.
 *      5 rows had a NULL date; all five are now derivable.
 *      1 row DIFFERS — id 18, stored 2026-08-17, derived 2026-08-15.
 *
 * That single disagreement is the one the ticket was filed about, and the
 * derivation sides with Google's own email ("On Aug 15, 2026 …") against our
 * stored value. 13/13 agreement elsewhere is what makes the 14th credible.
 *
 * ── The distinction this module refuses to blur ──────────────────────────
 *
 * A THRESHOLD CROSSING is a fact about our traffic. A MILESTONE BADGE is a
 * thing Google chose to award. They are not the same set: row 13's note records
 * that Google skipped 2K and 2.5K entirely, jumping 1.5K → 3K.
 *
 * So this computes crossings and says so. It does NOT write rows claiming
 * `source = 'google_search_console_email'` for badges Google never sent —
 * that would be inventing an award, which is precisely the fabricated-fact
 * failure the surrounding tickets (OPE-433, OPE-432) exist to stop. Nine such
 * crossings are currently unrecorded (100, 500, 2K, 2.5K, 4K, 8K, 9K, 10K,
 * 11K); whether the chart should plot our crossings or Google's badges is a
 * product decision, not a backfill.
 */

export interface DailyTotal {
  /** YYYY-MM-DD */
  date: string;
  clicks: number;
}

export interface Crossing {
  threshold: number;
  /** First date on which the trailing window reached the threshold. */
  reachedDate: string;
  /** The window total on that date — evidence, not just a verdict. */
  windowTotal: number;
}

/**
 * First date each threshold was reached by a trailing `windowDays` sum.
 *
 * Only windows with a FULL complement of days count. A partial window at the
 * start of the series sums fewer days and would report a crossing late (or, for
 * a low threshold, never) — and reporting a date we cannot actually support is
 * the failure mode this whole ticket family is about. Series shorter than the
 * window therefore yields nothing rather than a plausible guess.
 */
export function deriveCrossings(
  dailies: ReadonlyArray<DailyTotal>,
  thresholds: ReadonlyArray<number>,
  windowDays = 28
): Crossing[] {
  const sorted = [...dailies].sort((a, b) => a.date.localeCompare(b.date));
  const out: Crossing[] = [];
  const remaining = new Set(thresholds);

  for (let i = windowDays - 1; i < sorted.length; i++) {
    let total = 0;
    for (let j = i - windowDays + 1; j <= i; j++) total += sorted[j].clicks;
    // Ascending so several thresholds crossed on the same day all resolve to
    // that day, in order.
    for (const t of [...remaining].sort((a, b) => a - b)) {
      if (total >= t) {
        out.push({ threshold: t, reachedDate: sorted[i].date, windowTotal: total });
        remaining.delete(t);
      }
    }
    if (remaining.size === 0) break;
  }
  return out;
}

export type DateVerdict = "match" | "differs" | "stored_null" | "underivable";

export interface DateAudit {
  threshold: number;
  stored: string | null;
  derived: string | null;
  verdict: DateVerdict;
}

/**
 * Compare stored milestone dates against derived crossings.
 *
 * Exists so the derivation can be checked against human-entered history BEFORE
 * anything is corrected by it. A backfill that has not been validated against
 * the rows it is about to overwrite is just a confident rewrite.
 */
export function auditStoredDates(
  stored: ReadonlyArray<{ threshold: number; reachedDate: string | null }>,
  crossings: ReadonlyArray<Crossing>
): DateAudit[] {
  const byThreshold = new Map(crossings.map((c) => [c.threshold, c.reachedDate]));
  return stored.map((s) => {
    const derived = byThreshold.get(s.threshold) ?? null;
    let verdict: DateVerdict;
    if (derived === null) verdict = "underivable";
    else if (s.reachedDate === null) verdict = "stored_null";
    else verdict = s.reachedDate === derived ? "match" : "differs";
    return { threshold: s.threshold, stored: s.reachedDate, derived, verdict };
  });
}
