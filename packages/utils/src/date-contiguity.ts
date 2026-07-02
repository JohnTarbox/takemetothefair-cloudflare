/**
 * Date contiguity — the single source of truth for "are these dates a
 * gap-free, day-after-day run?". Shared between the public detail-page
 * display (DailyScheduleDisplay's "Daily:" label) and every ingest path
 * that sets `events.discontinuous_dates`, so the two agree by construction.
 *
 * OPE-47 (2026-07): the "Daily:" simplified label and the stored
 * `discontinuous_dates` flag were computed by two different, disagreeing
 * heuristics. The display trusted the flag; ingest set the flag from a bare
 * date COUNT (≥2 → discontinuous). A recurring market (every Saturday) could
 * therefore land `discontinuous_dates=0` and render "Daily", while a genuine
 * 3-day contiguous fair could land `discontinuous_dates=1` and lose its
 * "Daily" label. Routing both through this one pure helper removes the
 * divergence: `discontinuous_dates := !areDatesContiguous(dates)`.
 *
 * Pure function, no I/O. Dates are YYYY-MM-DD strings (how event_days.date is
 * stored). Parsing anchors to midnight UTC, so the inter-day delta is an exact
 * multiple of 86_400_000 ms regardless of the viewer's timezone.
 */

/** Parse a strict YYYY-MM-DD string to a midnight-UTC epoch, or null if the
 *  string is malformed or a non-existent calendar date (e.g. 2026-02-31). */
function parseYmdUTC(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  // Round-trip check rejects overflow dates (Date.UTC silently rolls them).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/**
 * True when `dates` form a genuinely consecutive, day-after-day run — i.e.
 * every gap between sorted, de-duplicated dates is exactly one calendar day.
 *
 * Edge cases (deliberate):
 *   - `[]` (empty)      → true  (vacuously contiguous; ingest reads this as
 *                                 "not discontinuous", the safe default).
 *   - single date       → true  (a one-day event is trivially "daily").
 *   - any unparseable    → false (conservative: never assert contiguity we
 *     date                        can't verify — better to fall through to the
 *                                 detailed / cadence view than mislabel).
 *   - a repeated date    → collapsed before the gap check, so accidental
 *                          duplicates don't read as a zero-day gap.
 */
export function areDatesContiguous(dates: ReadonlyArray<string>): boolean {
  if (dates.length <= 1) return true;

  const parsed: number[] = [];
  for (const s of dates) {
    const ms = parseYmdUTC(s);
    if (ms == null) return false; // can't verify → not contiguous
    parsed.push(ms);
  }

  // Sort, then de-dup so a repeated calendar date isn't seen as a 0-day gap.
  const sorted = [...new Set(parsed)].sort((a, b) => a - b);
  if (sorted.length <= 1) return true;

  for (let i = 1; i < sorted.length; i++) {
    const gapDays = Math.round((sorted[i] - sorted[i - 1]) / 86_400_000);
    if (gapDays !== 1) return false;
  }
  return true;
}
