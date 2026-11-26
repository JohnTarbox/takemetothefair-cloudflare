/**
 * OPE-1573 — strict `?page=` parsing for the public listing pages.
 *
 * `/events` and `/events/past` are `force-dynamic` and took
 * `parseInt(searchParams.page)` straight into an OFFSET. On 2026-11-13 at
 * 04:19Z a SQL-injection scanner sent ~100 `/events/past?page=2' UNION ALL
 * SELECT …` variants in two minutes. Drizzle binds parameters, so nothing was
 * injected — but `parseInt("2' UNION…")` is 2, so every variant was a full,
 * uncached render (list + count + vendor batch + event_days). D1 went to
 * "Requests queued for too long" and took /admin/analytics down with it.
 *
 * A page number is a short run of digits, and nothing else is. Anything else
 * is not a page we have, so the caller 404s BEFORE touching D1.
 *
 * Returns:
 * - `1` when the param is absent or empty (the unpaginated URL),
 * - the page number for `1`–`9999` written as plain digits (no sign, no
 *   leading zero, no whitespace),
 * - `null` for everything else, including repeated `?page=` keys.
 */
const PAGE_RE = /^[1-9][0-9]{0,3}$/;

export function parseListingPage(raw: string | string[] | undefined): number | null {
  if (raw === undefined || raw === "") return 1;
  if (typeof raw !== "string") return null;
  return PAGE_RE.test(raw) ? Number(raw) : null;
}
