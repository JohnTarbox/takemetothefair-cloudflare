/**
 * Event-date input normalization. Shared across the main app and the
 * MCP Worker (mcp-server), both of which ingest dates from a mix of
 * AI extractors, scrapers, admin forms, and external POST bodies.
 *
 * AI extraction and scrapers commonly return dates in bare YYYY-MM-DD
 * form. Parsing those via `new Date()` produces a midnight-UTC Date,
 * which renders as the PREVIOUS calendar day in every US timezone
 * (midnight UTC = 8pm EDT yesterday / 4pm PDT yesterday). Shifting to
 * noon UTC keeps the intended calendar day site-wide.
 *
 * Originally lived at src/lib/event-dates.ts (main app only). Promoted
 * to the workspace package by A3 (Dev backlog 2026-06-05) so the MCP
 * Worker's update_event tool — and any future ingest path — can wire
 * through the same canonical normalizer. Per the date-bug audit, 5
 * ingest paths bypassed this convention; they now all route through
 * here. See also drizzle/0074_event_dates_noon_utc.sql for the
 * historical midnight-UTC backfill.
 *
 * Gate `dateLooksTimezoneConfused` in event-date-gates.ts treats
 * 12:00:00 UTC as the canonical clean anchor (C1 flip 2026-06-05) and
 * flags 00:00:00 UTC as the symptom this normalizer prevents.
 */

export function normalizeEventDate(input: string | Date | null | undefined): Date | null {
  if (input == null) return null;

  // Date inputs: shift exact midnight UTC to noon UTC (matches the
  // string path's behavior). Non-midnight Date inputs are presumed to
  // carry a real time-of-day and pass through unchanged. A3 widened the
  // signature to accept Date because the scraper layer (ScrapedEvent
  // in src/lib/scrapers/types.ts) returns Date objects directly, often
  // already anchored at midnight UTC.
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    if (
      input.getUTCHours() === 0 &&
      input.getUTCMinutes() === 0 &&
      input.getUTCSeconds() === 0 &&
      input.getUTCMilliseconds() === 0
    ) {
      const noon = new Date(input.getTime());
      noon.setUTCHours(12, 0, 0, 0);
      return noon;
    }
    return input;
  }

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
