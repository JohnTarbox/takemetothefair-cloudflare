/**
 * OPE-108 — parse a Google Search Console "click milestone" congrats email into
 * a `gsc_milestone_emails` row so the admin "Search clicks milestones" chart stays
 * current without hand-entered SQL.
 *
 * Source emails: sender `sc-noreply@google.com`, subject like
 *   "Congrats on reaching 3K clicks in 28 days!"
 * body carries the site URL and a "reached" date ("...in the past 28 days /
 * Jul 4, 2026"). The threshold uses K-shorthand ("3K", "1.5K", "1.2K", "2.5K").
 *
 * PURE + no I/O + never throws. Returns null for anything that isn't a
 * recognisable GSC milestone email (the caller treats null as "not a milestone").
 */

export interface GscMilestone {
  /** "clicks" (the only metric these emails report today) or "impressions". */
  metric: string;
  /** Rolling window from the subject — 28 for the standard email. */
  windowDays: number;
  /** Absolute click count: "3K" → 3000, "1.5K" → 1500, "500" → 500. */
  threshold: number;
  /** Google's cited impact date as YYYY-MM-DD, or null when the body omits it. */
  reachedDate: string | null;
  /** OPE-456 — how `reachedDate` was obtained; null when there is none. */
  reachedDateSource: ReachedDateSource | null;
  /** The email's received date as YYYY-MM-DD (the chart string-sorts on this). */
  emailDate: string;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Parse a threshold token to its absolute integer value.
 *   "3K" → 3000 · "1.5K" → 1500 · "1.2K" → 1200 · "2.5K" → 2500 · "500" → 500 ·
 *   "12,000" → 12000. Returns null when the token isn't a number (± K suffix).
 */
export function parseThresholdToken(raw: string): number | null {
  const m = String(raw)
    .trim()
    .match(/^([\d,]+(?:\.\d+)?)\s*([kK])?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2] ? n * 1000 : n);
}

/**
 * Extract a YYYY-MM-DD date from free text, handling the two shapes these emails
 * carry: "Jul 4, 2026" (month day, year) and RFC-2822 "06 Jul 2026" (day month
 * year), plus a bare ISO "2026-07-04". Returns null when no date is found.
 * Built without `new Date(...)` so a timezone can never shift the calendar day.
 */
export function extractDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = String(text);

  // ISO first — unambiguous. No trailing \b (a datetime like 2026-07-06T12:00
  // has no word boundary between the day digit and the "T"); guard with a
  // not-a-digit lookahead so we don't clip a longer number.
  const iso = s.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "Jul 4, 2026" / "July 4 2026"
  const mdy = s.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (mdy) {
    const mon = MONTHS[mdy[1].toLowerCase().slice(0, 3)];
    return `${mdy[3]}-${String(mon).padStart(2, "0")}-${String(Number(mdy[2])).padStart(2, "0")}`;
  }

  // "06 Jul 2026" (RFC-2822 date header order)
  const dmy = s.match(
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i
  );
  if (dmy) {
    const mon = MONTHS[dmy[2].toLowerCase().slice(0, 3)];
    return `${dmy[3]}-${String(mon).padStart(2, "0")}-${String(Number(dmy[1])).padStart(2, "0")}`;
  }

  return null;
}

/**
 * OPE-456 — the reached date, anchored to the sentence that states it.
 *
 * `extractDate` returns the FIRST date anywhere in the text. That is correct for
 * a header, and wrong for a forwarded email body, which opens with the forward
 * block:
 *
 *     ---------- Forwarded message ---------
 *     From: Google Search Console <sc-noreply@google.com>
 *     Date: Mon, Aug 17, 2026 at 6:03 AM
 *     ...
 *     On Aug 15, 2026 your site reached 12K clicks in 28 days
 *
 * The first date is the FORWARD date. The milestone's actual date is in the
 * sentence containing "reached". Row 18 stored 2026-08-17 for a milestone Google
 * dated Aug 15 for exactly this reason — not, as first supposed, because the
 * ingest substituted `email_date`. It never does; it stored a real parse of the
 * wrong sentence.
 *
 * So: look for a date in a line that mentions reaching/reached first, and only
 * fall back to the unanchored scan. The caller is told which happened, because
 * an unanchored date on a forwarded mail is exactly the value that should not
 * be trusted to overwrite a good one.
 */
export type ReachedDateSource = "anchored" | "unanchored";

export interface ReachedDate {
  date: string | null;
  source: ReachedDateSource | null;
}

export function extractReachedDate(text: string | null | undefined): ReachedDate {
  if (!text) return { date: null, source: null };

  // Scan FORWARD from each mention of reaching the milestone. Forward-only is
  // the load-bearing detail: a forwarded email's block is
  //
  //     Date: Mon, Aug 17, 2026 at 6:03 AM      <- the forward date
  //     Subject: Congrats on reaching 12K …     <- first "reaching"
  //     …
  //     On Aug 15, 2026 your site reached 12K   <- the real one
  //
  // The `Date:` header ALWAYS precedes `Subject:`, so looking only forward
  // steps over it, while a symmetric window around the match would grab it.
  // Line-scoped matching does not work either: Google's own body puts the date
  // on the line AFTER the sentence ("… in the past 28 days\nJul 4, 2026").
  const src = String(text);
  const LOOKAHEAD = 300;
  for (const m of src.matchAll(/reach(?:ed|ing)/gi)) {
    const from = m.index ?? 0;
    const d = extractDate(src.slice(from, from + LOOKAHEAD));
    if (d) return { date: d, source: "anchored" };
  }

  const fallback = extractDate(text);
  return { date: fallback, source: fallback ? "unanchored" : null };
}

/** Coerce a Date or a date-ish string to YYYY-MM-DD (UTC calendar day). */
function toIsoDate(d: string | Date | null | undefined): string | null {
  if (d == null) return null;
  if (d instanceof Date) {
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  return extractDate(d);
}

/**
 * Parse a GSC milestone email. Returns the row fields, or null when the subject
 * isn't a recognisable "reaching <N> clicks in <D> days" milestone.
 */
export function parseGscMilestoneEmail(input: {
  subject: string | null | undefined;
  body?: string | null;
  emailDate: string | Date;
}): GscMilestone | null {
  const subject = String(input.subject ?? "");
  const sm = subject.match(
    /reaching\s+([\d.,]+\s*[kK]?)\s+(clicks|impressions)\s+in\s+(\d+)\s+days/i
  );
  if (!sm) return null;

  const threshold = parseThresholdToken(sm[1]);
  if (threshold == null || threshold <= 0) return null;

  const emailDate = toIsoDate(input.emailDate);
  if (!emailDate) return null;

  const windowDays = Number.parseInt(sm[3], 10);
  const reached = extractReachedDate(input.body);
  return {
    metric: sm[2].toLowerCase(),
    windowDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 28,
    threshold,
    reachedDate: reached.date,
    reachedDateSource: reached.source,
    emailDate,
  };
}
