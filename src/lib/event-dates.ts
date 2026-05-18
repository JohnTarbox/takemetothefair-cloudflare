/**
 * Event-date input normalization for the suggest-event submit path.
 *
 * AI extraction returns dates in bare YYYY-MM-DD form. Parsing those
 * via `new Date()` produces a midnight-UTC Date, which renders as the
 * PREVIOUS calendar day in every US timezone (midnight UTC = 8pm EDT
 * yesterday / 4pm PDT yesterday). Shifting to noon UTC keeps the
 * intended calendar day site-wide.
 *
 * Backfill for existing midnight-UTC rows: drizzle/0074_event_dates_noon_utc.sql
 */

export function normalizeEventDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  // Bare YYYY-MM-DD (no T separator) → append noon UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s = `${s}T12:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z?$/.test(s)) {
    // Explicit midnight UTC (with or without milliseconds / Z) → noon UTC
    s = s.slice(0, 10) + "T12:00:00Z";
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
