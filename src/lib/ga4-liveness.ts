/**
 * GA4 liveness age arithmetic.
 *
 * Lives here rather than in the route because App Router route files may only
 * export HTTP verbs and the framework config keys — an extra named export
 * fails the build's route type check — and because a threshold you cannot
 * inject a clock into is a threshold nobody tests. That is precisely how the
 * bug below survived 98 days.
 *
 * ── The defect this module exists to fix ──
 *
 * Measured in production 2026-08-12: `ga4_liveness_log` held 97 rows spanning
 * 2026-05-06 → 2026-08-12 and EVERY ONE was `degraded`, with
 * `data_age_seconds` = 30.0h on every single row. `consecutive_failures` had
 * reached 97 and `ga4.liveness_alert` had fired 96 times.
 *
 * GA4 was healthy the whole time. The check runs at 06:00Z, GA4's freshest
 * complete day is "yesterday", and the age was anchored at MIDNIGHT of that
 * date — so the smallest age it could ever observe was 30h, compared against
 * a 24h `degraded` threshold. Green was unreachable by construction: an alarm
 * that could only ever cry wolf.
 *
 * Found while building the Bing analogue (OPE-309 A5), which deliberately did
 * not copy it. `src/lib/bing-liveness.ts` carries the same anchoring rule.
 */

const DAY_MS = 24 * 3600 * 1000;

/**
 * Seconds elapsed since the END of the day named by `isoDate` (UTC).
 *
 * The end, not the start — that one word is the fix. A GA4 row dated D reports
 * on the whole of day D, so it is not late until day D has ended:
 *
 *   healthy (data = yesterday, checked 06:00Z)  ->   6h  -> green
 *   one day missing                             ->  30h  -> degraded
 *   two days missing                            ->  54h  -> critical
 *
 * Clamped at 0 so a same-day or future-dated row reads as fresh rather than
 * negative. Returns null for null/unparseable input — a date we cannot read is
 * not evidence of freshness, and the caller treats null as critical.
 */
export function computeAgeSeconds(isoDate: string | null, now: Date = new Date()): number | null {
  if (!isoDate) return null;
  const dayStart = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(dayStart)) return null;
  return Math.max(0, Math.floor((now.getTime() - (dayStart + DAY_MS)) / 1000));
}
