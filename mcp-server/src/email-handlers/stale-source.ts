/**
 * OPE-458 scope 2 — "these events happened" vs "this page is stale".
 *
 * A bare URL to `vineyardartisans.com` was submitted on 2026-08-17. The page is
 * frozen at 2024, so the extractor faithfully read it and produced events dated
 * **2024-06-15** and **2024-12-07** — 26 months in the past, created as fresh
 * PENDING submissions with no flag and no lifecycle transition.
 *
 * Scope 1 (shipped) stops each of those individually: a candidate dated before
 * its own submission no longer becomes a SCHEDULED event. But the per-event
 * guard answers the wrong question. Told one at a time, "this event is in the
 * past" is a statement about the event. Told about every candidate on a page at
 * once, the same fact is a statement about the SOURCE — and that is the one
 * worth acting on, because it is the difference between "we filed your events
 * as past" and "the page you sent us has not been updated since 2024."
 *
 * The submitter can fix the second and can do nothing about the first.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * A source is stale when EVERY dated candidate it produced is in the past, and
 * the newest of them is older than `STALE_MARGIN_DAYS`.
 *
 * **Every**, because one past and one future date means the page is being
 * maintained — last year's edition is simply still listed, which is normal and
 * not a defect.
 *
 * **A margin**, because a page for a fair held last weekend is not stale, it is
 * post-event; those rows legitimately become OCCURRED through OPE-201's
 * existing rail, and calling that page "not updated" would be both wrong and
 * insulting to an organizer who runs one fair a year. 90 days is comfortably
 * past any single event's tail and far short of the 26 months in the specimen.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────
 *
 * It never guesses a current date. The ticket is explicit and it is the same
 * rule OPE-433 sets: if the page is stale, the correct output is "we could not
 * determine current dates", not a plausible substitute. Shifting 2024 to 2026
 * would manufacture a fact no source asserts.
 *
 * A source with no parseable dates at all is NOT stale — it is unknown. Absence
 * of dates is a different failure (extraction, or a page that never carried
 * them), and reporting it as staleness would send the submitter to fix a page
 * that may be perfectly current.
 */

/** Below this, a past date is "the event has happened", not "the page is dead". */
export const STALE_MARGIN_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleCandidate {
  /** Sanitized `YYYY-MM-DD`, or null when the extractor found no date. */
  startDate?: string | null;
}

export interface StalenessVerdict {
  stale: boolean;
  /** How many candidates carried a parseable date — the evidence base. */
  datedCount: number;
  /** Age in whole days of the NEWEST dated candidate; null when none were dated. */
  newestAgeDays: number | null;
  reason: string;
}

function ageDays(iso: string, nowMs: number): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}

/**
 * Judge one source's candidates as a set.
 *
 * `nowMs` is injected rather than read from the clock so the verdict is
 * reproducible in tests and identical across a workflow's retries — a step that
 * re-runs an hour later must not reach a different conclusion.
 */
export function classifySourceStaleness(
  candidates: ReadonlyArray<StaleCandidate>,
  nowMs: number
): StalenessVerdict {
  const ages: number[] = [];
  for (const c of candidates) {
    if (!c.startDate) continue;
    const a = ageDays(c.startDate, nowMs);
    if (a !== null) ages.push(a);
  }

  if (ages.length === 0) {
    return {
      stale: false,
      datedCount: 0,
      newestAgeDays: null,
      reason: "no dated candidates — unknown, not stale",
    };
  }

  // The newest candidate is the smallest age. If even IT is far in the past,
  // nothing on this page is forthcoming.
  const newestAgeDays = Math.min(...ages);

  if (newestAgeDays <= 0) {
    return {
      stale: false,
      datedCount: ages.length,
      newestAgeDays,
      reason: "at least one candidate is upcoming — the page is being maintained",
    };
  }

  if (newestAgeDays < STALE_MARGIN_DAYS) {
    return {
      stale: false,
      datedCount: ages.length,
      newestAgeDays,
      reason: `newest candidate is ${newestAgeDays}d old — recently held, not a dead page`,
    };
  }

  return {
    stale: true,
    datedCount: ages.length,
    newestAgeDays,
    reason: `all ${ages.length} dated candidate(s) are past; the newest is ${newestAgeDays}d old`,
  };
}

/**
 * The registrable host of a source URL, lowercased, `www.` removed — the key
 * `source_reliability` is already keyed on (its one live row is
 * `visitrhodeisland.com`). Returns null for anything unparseable so a caller
 * never writes a junk key.
 */
export function sourceDomainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h || null;
  } catch {
    return null;
  }
}
