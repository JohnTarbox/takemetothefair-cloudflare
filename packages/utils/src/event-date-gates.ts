/**
 * Pre-ingest date-quality gates. Central evaluator that every event-ingest
 * path calls before persisting a new event. If the gate routes to
 * PENDING_REVIEW, the ingest path overrides editorial status to PENDING
 * and records the firing reasons in events.gate_flags (JSON-string column,
 * drizzle/0069).
 *
 * Motivation (analyst 2026-05-16 spot-check): 5 events from TEC-API
 * aggregator sources arrived with semantically-wrong dates and slipped
 * straight to APPROVED — start_date set to application deadline (NH Maker
 * Fest); single-day record of a multi-day festival (Northeast Coffee
 * Festival); stale prior-year dates (Cape Cod Chamber); sub-component of
 * a multi-venue festival ingested as the whole event (Arts Alley). These
 * gates encode the failure modes as pre-ingest checks so the same data
 * routes to PENDING_REVIEW for admin verification instead.
 *
 * Per memory `project_event_insert_paths.md` there are 5 main-app ingest
 * paths plus the MCP suggest_event tool. Every one wires through
 * evaluateGates() — keep this single source of truth.
 */

import { decodeHtmlEntities } from "./index";
import {
  hasCalendarDayPassed,
  toIsoDateOnly,
  toIsoDateOnlyInVenueZone,
} from "@takemetothefair/datetime";

// ---------------------------------------------------------------------------
// Source credibility tiers
// ---------------------------------------------------------------------------
//
// Tier 1: direct human input (admin / promoter / vendor through dashboards).
//         Highest trust; gates only fire on date-plausibility failures.
// Tier 2: named scrapers we maintain (mainefairs.net etc.). Medium trust;
//         all gates apply; failures land in PENDING_REVIEW.
// Tier 3: third-party TEC aggregators (regional/chamber feeds). Lowest
//         trust; ALWAYS route to PENDING_REVIEW regardless of other gates.
//
// Sources we know are Tier 3 today (analyst 2026-05-16 audit):
//   lakesregion.org, mainetourism.com, capecodchamber.org, berkshires.org
// Plus any source containing the TEC-API marker substring.

// Tier 3 — regional / DMO aggregator hosts that have historically shipped
// wrong dates. Confirmed by the analyst 2026-05-16 follow-up. Plus the
// implicit rule "any other regional chamber / DMO TEC feed not on the
// Tier 2 allowlist below" — captured here as the explicit list we know
// about; expand when new aggregator hosts surface.
const TIER_3_HOSTS = new Set<string>([
  "lakesregion.org",
  "berkshires.org",
  "capecodchamber.org",
  "visitwhitemountains.com",
  "mainemade.com",
  "visitfreeport.com",
  // Other regional DMOs not in the Tier 2 allowlist — treat as Tier 3
  // until they earn promotion by surfacing clean data over time.
  "mass-vacation.com",
  "visitmaine.com",
  "vermont.com",
  "visitri.com",
  "visitconnecticut.com",
]);

// Tier 2 — DMO/aggregator hostnames the analyst has confirmed produce
// generally-clean data; name-pattern and date-plausibility gates still
// apply, but Tier 2 is auto-approve when those pass.
//
// CAVEAT (analyst 2026-05-16): mainetourism.com was the source of the
// NH Maker Fest "CALL FOR MAKERS" error. Keeping it in Tier 2 with strict
// gates; if PENDING_REVIEW rate per source exceeds 30% after a month of
// observation, demote to Tier 3.
const TIER_2_AGGREGATOR_HOSTS = new Set<string>([
  "mainetourism.com",
  "visitrhodeisland.com",
  "visitvermont.com",
  "ctvisit.com",
  "visitnh.gov",
]);

// Tier 2 source-name identifiers — internal scraper sources we maintain
// in-repo. Same trust level as Tier 2 aggregator hosts (gated but
// auto-approve on clean data).
const TIER_2_SOURCE_NAMES = new Set<string>([
  "mainefairs.net",
  "mainefairs",
  "fairgrounds-scraper",
  "newengland-fairs",
  // Add to packages/scrapers when registering a new one.
]);

// Known hosts that serve multi-row event-calendar PDFs (city civic
// venues, town schedules). Events ingested from these sources benefit
// from per-row admin review because AI extraction has been observed to
// carry organizer/name context across rows. Expand as new sources are
// discovered. The PDF extension check below caps the false-positive
// rate — non-PDF pages on the same host (event detail pages) aren't
// flagged.
const MULTIROW_PDF_HOSTS = new Set<string>([
  // Concord NH Everett Arena 2026 spring/summer schedule PDF caused the
  // NHAC Gun Collectors Show false-attribution case (an Antiques & Book
  // Show row at the same venue got the prior row's organizer carried
  // forward by the AI extractor).
  "concordnh.gov",
]);

/** Detect a multi-row-PDF source URL. Match = host in MULTIROW_PDF_HOSTS
 *  AND the URL path ends in .pdf (case-insensitive). Non-PDF pages on
 *  the same host pass through unflagged. */
export function sourceLooksLikeMultirowPdf(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!MULTIROW_PDF_HOSTS.has(host)) return false;
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Resolve a credibility tier for an event's source. Accepts either a
 *  bare hostname, a URL, or the project's `sourceName` string. */
export function sourceCredibilityTier(source: string | null | undefined): 1 | 2 | 3 {
  if (!source) return 1; // No source = direct input. Trust the caller.
  const normalized = source.toLowerCase().trim();

  // TEC-API hostnames or any source string explicitly marked as such
  if (normalized.includes("tec-api") || normalized.includes("traveler.aero")) return 3;

  // Extract hostname if a URL was passed; otherwise treat the whole string
  // as the candidate identifier.
  let host = normalized;
  try {
    const u = new URL(normalized.startsWith("http") ? normalized : `https://${normalized}`);
    host = u.hostname.replace(/^www\./, "");
  } catch {
    // Not a URL — keep the original string for sourceName lookup
  }

  if (TIER_3_HOSTS.has(host)) return 3;
  if (TIER_2_AGGREGATOR_HOSTS.has(host)) return 2;
  if (TIER_2_SOURCE_NAMES.has(host) || TIER_2_SOURCE_NAMES.has(normalized)) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Name-pattern flags
// ---------------------------------------------------------------------------
//
// Event names that announce themselves as something other than a real event
// listing: vendor calls, sub-venue suffixes, registration pages.

// Patterns that surface as flags. Each entry documents the failure mode it
// guards against. Tests in __tests__/event-date-gates.test.ts. The `match`
// field is either a regex (simple substring/word check) or a predicate
// function for patterns that need more context-aware logic.
type NamePattern = {
  reason: string;
  match: RegExp | ((decodedName: string) => boolean);
};
const NAME_PATTERNS: NamePattern[] = [
  // "CALL FOR ARTISTS", "Call for Vendors", "Call for Submissions"
  { reason: "name_call_for_pattern", match: /\bcall for\b/i },
  // "Vendor REGISTRATION Open", "Registration Now Available", "REGISTER NOW".
  // Broadened 2026-05-22 (analyst follow-up): the original /\bregistration\b/
  // missed "REGISTER" as a standalone word — caught only the -ation form.
  // The alternation now covers both "register" and "registration".
  { reason: "name_registration_pattern", match: /\bregist(?:er|ration)s?\b/i },
  // "Apply Today", "Vendor Applications Open", "Vendor Application — Open".
  // Broadened 2026-05-22 (analyst follow-up): the original /\bapply\b/ did
  // NOT match "application" because the `y`→`i` boundary fails the \b
  // requirement. Names like "Vendor Application Open" slipped through.
  // The alternation now covers apply / application / applications.
  { reason: "name_apply_pattern", match: /\bappl(?:y|ication|ications)\b/i },
  // Sub-venue / sub-component markers — "Arts Alley Sub-Venue", "Component:
  // Children's Tent". A real top-level event wouldn't include the word
  // sub-venue or component in its own name. Catches the Lakes Region Arts
  // Festival "Field B" type case from a different angle than the em-dash
  // rule (em-dash rule covers "X — Field B"; this catches "X subvenue Y"
  // or "Children Component" type names). `sub.?venue` covers "subvenue",
  // "sub-venue", "sub venue".
  { reason: "name_subvenue_component", match: /\b(?:sub.?venue|component)\b/i },
  // Em-dash sub-venue suffix: "Concord Arts Festival — Arts Alley" indicates
  // a sub-component, not a top-level event. Hyphen and en-dash are NOT
  // flagged (those appear in normal names like "rock-n-roll"). The 2026-05-17
  // production scan surfaced ~233 false positives (74% of em-dash hits) from
  // show-series city/year qualifiers — "New England Home Show — Marlboro 2026",
  // "Brattleboro Area Farmers Market — 2026-05-02", "VSRPA Gun Show — Derby, VT".
  // emDashSuffixLooksLikeSubvenue() blocklists year/date/season/state-code
  // suffixes so only true sub-venue-like suffixes still fire.
  { reason: "name_em_dash_subvenue", match: emDashSuffixLooksLikeSubvenue },
];

// Suffix patterns that indicate a non-sub-venue qualifier on the right side
// of an em-dash. When the suffix matches any of these, em-dash is treated as
// a series/recurrence separator, not a sub-component indicator.
const NON_SUBVENUE_SUFFIX_PATTERNS = [
  // Any 4-digit year (covers "2026", "Marlboro 2026", "Spring 2026",
  // "2026-05-02" ISO dates — all contain 4 consecutive digits).
  /\b\d{4}\b/,
  // Season name standalone or with other text but no year (rare; mostly
  // covered by the year rule, but guards "— Spring" / "— Fall").
  /\b(?:spring|summer|fall|autumn|winter)\b/i,
  // Trailing 2-letter US state code: "— Derby, VT", "— Boston, MA".
  /,\s*[A-Z]{2}\s*$/,
  // mm/dd/yyyy or mm/dd/yy date format.
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  // OPE-1032 (ratified 2026-09-15) — edition / series / town qualifiers that the
  // weekly drain measured at 9 of 9 false positives:
  //   "— June 29", "— November"            a month (with or without a day)
  //   "— 500th Lighting", "— 25th Annual"  an ordinal edition
  //   "— America 250"                      a 3-digit anniversary number
  //   "— West Kingston RI", "— Westerly RI" a town with a bare state code (the
  //     comma form above missed these, and renaming one town to another
  //     re-tripped the gate on the corrective edit itself)
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  /\b\d+(?:st|nd|rd|th)\b/i,
  /\b\d{3}\b/,
  /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$/,
];

/** Decide whether an em-dash suffix represents a sub-venue (= flag) or a
 *  series/recurrence qualifier (= skip). Returns true to flag. */
function emDashSuffixLooksLikeSubvenue(decodedName: string): boolean {
  const m = decodedName.match(/\s—\s(.+)$/);
  if (!m) return false;
  const suffix = m[1].trim();
  if (NON_SUBVENUE_SUFFIX_PATTERNS.some((p) => p.test(suffix))) return false;
  return true;
}

export interface NameFlagResult {
  matched: boolean;
  reasons: string[];
}

export function nameMatchesAdminFlag(name: string | null | undefined): NameFlagResult {
  if (!name) return { matched: false, reasons: [] };
  // Decode HTML entities first — name may have arrived from JSON-LD with
  // `&amp;` / `&#8212;` etc. Memory `feedback_mcp_input_decode.md` covers
  // why this matters at every text-input boundary.
  const decoded = decodeHtmlEntities(name);
  const reasons = NAME_PATTERNS.filter((p) =>
    typeof p.match === "function" ? p.match(decoded) : p.match.test(decoded)
  ).map((p) => p.reason);
  return { matched: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Date-plausibility checks
// ---------------------------------------------------------------------------

export interface DateGateInput {
  startDate: Date | null | undefined;
  endDate: Date | null | undefined;
  applicationDeadline?: Date | null | undefined;
  /** Description text used to detect multi-day language. Pass the raw
   *  description; helper handles case + decoding. */
  description?: string | null | undefined;
  /** Optional event_scale (SMALL/MEDIUM/LARGE/MAJOR). Used by the long-
   *  duration plausibility check below — multi-week events with no
   *  MAJOR scale tag are almost always a recurring-series row that
   *  got ingested as if it were a single event. Omit to skip that
   *  check (preserves backwards compat for callers that don't yet
   *  pass scale). */
  eventScale?: string | null | undefined;
  /** True when the event represents a recurring/periodic series
   *  (every-other-Saturday market, biweekly hamfest, etc.). When set,
   *  the duration-too-long-for-scale check is bypassed — a long
   *  start→end span is the expected season-span shape, not a malformed
   *  single event. Pass alongside eventDaysCount; either signal alone
   *  suffices. */
  discontinuousDates?: boolean | null | undefined;
  /** Count of associated event_days rows. ≥3 rows is treated as
   *  authoritative evidence the event is a multi-occurrence series and
   *  the duration check is bypassed (mirrors discontinuousDates). At
   *  ingest time event_days may not exist yet; pass the flag instead. */
  eventDaysCount?: number | null | undefined;
  /** OPE-1032 — `events.categories` (JSON array string or array). A season-long
   *  category (Holiday Market) bypasses the duration-too-long gate. */
  categories?: string | readonly string[] | null | undefined;
}

export type DateGateResult = { ok: true } | { ok: false; reasons: string[] };

const MAX_FUTURE_MS = 18 * 30 * 86400 * 1000; // ~18 months
// Duration plausibility: events lasting more than this without a MAJOR
// scale tag are almost certainly a recurring-series row (e.g., a farmers
// market that runs every Saturday for 6 months, ingested as if it were
// one event from start to end). True multi-week events at MMATF scale
// (state fairs, major expos) tag eventScale=MAJOR and bypass this check.
const MAX_DURATION_MS_NON_MAJOR = 14 * 86400 * 1000; // 14 days
// Multi-day terms in descriptions that contradict a single-day start==end.
const MULTI_DAY_PATTERNS = [
  /\b(?:2|3|4|5|6|7|two|three|four|five|six|seven)[-\s]day\b/i,
  /\bweekend\b/i,
  /\bfriday\s*(?:through|to|-|–|—)\s*sunday\b/i,
  /\bfri\s*(?:through|to|-|–|—)\s*sun\b/i,
  /\bsat\s*(?:through|to|-|–|—)\s*sun\b/i,
  /\bmulti[-\s]day\b/i,
];

function sameDay(a: Date, b: Date): boolean {
  // OPE-526 — compare CALENDAR DAYS in UTC, not a millisecond delta.
  //
  // The delta form was `< 12h`, and the codebase's two date-only parsers sit
  // EXACTLY 12h apart: normalizeEventDate anchors at 12:00Z (deliberately, to
  // survive timezone shifts) and parseDateOnly at 00:00Z. `12h < 12h` is
  // false, so any caller mixing the two got a permanent silent `false` — not a
  // timezone edge case, but every date, always. That is how
  // start_equals_deadline came to be wired on import-url by OPE-198 yet unable
  // to fire whenever the extractor produced no event-days (route.ts:162 takes
  // the noon-anchored branch while the deadline stays midnight-anchored).
  //
  // Comparing calendar days is what every caller actually meant, and it is
  // immune to which parser produced either side.
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** Gate A4 (analyst spec 2026-05-16; C1 noon-anchor flip 2026-06-05):
 *  catches the date-only-misparsed-as-timestamp bug. When a source provides
 *  a date-only ISO ("2026-07-15") or a date with an explicit non-UTC zone
 *  ("2026-07-15T20:00:00-04:00") and the ingest path doesn't normalize
 *  through normalizeEventDate, the stored start_date can end up on a
 *  different UTC calendar day than the source intended.
 *
 *  Since the noon-UTC anchor convention (PR-Q #200), the site stores
 *  date-only ingests at 12:00:00 UTC specifically to avoid US-EDT
 *  off-by-one rendering. The OLD form of this gate treated midnight UTC
 *  as the canonical clean anchor and flagged off-midnight as confused —
 *  which cried wolf on every correctly-anchored event after the noon
 *  convention shipped. The C1 flip (2026-06-05) inverts the test:
 *
 *    - 12:00:00 UTC → CLEAN (the canonical noon anchor)
 *    - 00:00:00 UTC → CONFUSED (the A3 / K14 symptom — date-only ingest
 *      bypassed normalizeEventDate, parsed as midnight)
 *    - non-quarter-hour minutes (m % 15 !== 0) or non-zero seconds →
 *      CONFUSED (no human-meaningful event time uses those)
 *    - other quarter-hour-aligned UTC times → defer to description: if
 *      the source mentions a time, the stored value is legitimately
 *      preserving it. */
function dateLooksTimezoneConfused(input: DateGateInput): boolean {
  // OPE-1032 (ratified by John 2026-09-15) — fire ONLY when the stored instant
  // puts the event on a different calendar day in the venue zone than in UTC.
  //
  // The rules this replaces — "any quarter-hour time is confused unless the
  // description mentions a time", "non-quarter-hour minutes are confused" —
  // flagged the platform's own storage shapes: local midnight at 04:00Z and
  // real start times at 13:00–15:00Z. Three weekly drains (09-01, 09-09,
  // 09-15) measured that class at ~100% false positive; 12 of 12 on 09-15.
  // A corrected start time also re-tripped the gate on the very edit that
  // fixed it (the Ricker Hill 10am specimen).
  //
  // The date comparison is what the harm actually is: date-only fields render
  // in America/New_York (OPE-482), so a start whose Eastern day differs from
  // its UTC day is shown on the wrong day. It still catches every case the old
  // gate existed for — 00:00:00Z is the previous Eastern day, and so is a
  // 04:00Z local-midnight value on a winter date, which the old gate passed
  // whenever the description happened to mention a time.
  if (!input.startDate || isNaN(input.startDate.getTime())) return false;
  return toIsoDateOnly(input.startDate) !== toIsoDateOnlyInVenueZone(input.startDate);
}

const SEASON_LONG_CATEGORIES = new Set(["holiday market"]);

function hasSeasonLongCategory(categories: DateGateInput["categories"]): boolean {
  if (!categories) return false;
  let list: unknown = categories;
  if (typeof categories === "string") {
    try {
      list = JSON.parse(categories);
    } catch {
      return false;
    }
  }
  return (
    Array.isArray(list) &&
    list.some((c) => typeof c === "string" && SEASON_LONG_CATEGORIES.has(c.trim().toLowerCase()))
  );
}

const MONTH_NAME =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** "November 7 – December 28", "Nov 24 through Jan 3", "November to December". */
const MONTH_SPAN_RE = new RegExp(
  `\\b${MONTH_NAME}(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?,?\\s*(?:-|–|—|to|through|thru|until)\\s*${MONTH_NAME}\\b`,
  "i"
);

function descriptionStatesMonthSpan(description: string | null | undefined): boolean {
  if (!description) return false;
  const decoded = decodeHtmlEntities(description);
  for (const m of decoded.matchAll(new RegExp(MONTH_SPAN_RE.source, "gi"))) {
    // Two DIFFERENT month names — "June 5 - June 7" is a short run, not a season.
    const names = m[0].toLowerCase().match(new RegExp(MONTH_NAME, "gi")) ?? [];
    const first = names[0];
    const last = names[names.length - 1];
    if (first && last && names.length >= 2 && first.slice(0, 3) !== last.slice(0, 3)) {
      return true;
    }
  }
  return false;
}

export function dateLooksImplausible(input: DateGateInput): DateGateResult {
  const reasons: string[] = [];
  const now = new Date();

  if (dateLooksTimezoneConfused(input)) {
    // Gate A4 (OPE-1032 semantics): the stored start renders on a different
    // calendar day in the venue zone than in UTC — a misparsed date-only
    // source or an un-normalized offset timestamp that is visibly wrong.
    reasons.push("start_date_timezone_confused");
  }

  if (
    input.startDate &&
    input.applicationDeadline &&
    sameDay(input.startDate, input.applicationDeadline)
  ) {
    // The NH Maker Fest failure mode: scraper grabbed the application
    // deadline as the event start date. Always suspicious.
    reasons.push("start_equals_deadline");
  }

  if (input.startDate && input.endDate && sameDay(input.startDate, input.endDate)) {
    // Single-day storage of an event whose description claims multi-day.
    // Northeast Coffee Festival, Rhododendron Festival failure modes.
    if (input.description) {
      const decoded = decodeHtmlEntities(input.description);
      if (MULTI_DAY_PATTERNS.some((p) => p.test(decoded))) {
        reasons.push("start_equals_end_but_description_multi_day");
      }
    }
  }

  if (input.startDate && input.startDate.getTime() > now.getTime() + MAX_FUTURE_MS) {
    // Stale-or-fabricated future date. Anything more than 18 months out
    // is almost certainly wrong (event dates aren't typically known that
    // far in advance for the fair circuit).
    reasons.push("start_too_far_future");
  }

  // OPE-651 — a DAY comparison, not an instant one.
  //
  // This was `input.endDate.getTime() < now.getTime()`. Event dates are anchored
  // at noon UTC, so that flipped to "past" at 12:00Z — 08:00 Eastern — on the
  // event's OWN MORNING. A car show running 10:00-15:00 EDT was flagged
  // `end_date_in_past` about two hours before it opened, and stayed flagged all
  // day; the flag then demoted the row out of the publication path on the one
  // day the directory most needed to say "this is on today".
  //
  // The Cape Cod Chamber case this gate exists for — prior-year dates carried
  // forward in an aggregator feed — is unaffected: those are months past, not
  // hours.
  if (input.endDate && hasCalendarDayPassed(input.endDate, now)) {
    // Past end date for a newly-ingested event. The Cape Cod Chamber
    // failure mode: prior-year dates carried forward in the aggregator
    // feed. APPROVED past-end-date events are also caught by
    // confirm_past_event_occurrence post-fact, but flag here too so the
    // initial ingest doesn't silently insert stale data.
    reasons.push("end_date_in_past");
  }

  // OPE-651 — same day-vs-instant correction as `end_date_in_past` above. A
  // single-day event with no end date was "in the past" from 08:00 Eastern on
  // the morning it happened.
  if (input.startDate && hasCalendarDayPassed(input.startDate, now) && !input.endDate) {
    // OPE-201: a single-day auto-create whose START is already past (no end
    // date) is almost always a real PAST EDITION — the Washington County Fair
    // 2025 poster case. A fully-past multi-day event is caught by
    // end_date_in_past above; an in-progress event (start past, end future) is
    // legitimately upcoming and NOT flagged. Route this to review so it lands
    // PENDING for web-confirm → OCCURRED (analyst lane), not silently APPROVED.
    reasons.push("start_date_in_past");
  }

  // Recurring-event exemption (analyst 2026-05-26 follow-up to PR #209):
  // a legitimately periodic series (Artisans' Market in Unity — biweekly
  // May–Dec, the three Farmington farmers markets — weekly season spans)
  // SHOULD have a long start→end span; that span is the season, not a
  // malformed single event. Either signal is sufficient evidence:
  //   - discontinuousDates flag set at ingest, OR
  //   - ≥3 event_days rows already persisted (admin PATCH path).
  const isRecurringSeries = input.discontinuousDates === true || (input.eventDaysCount ?? 0) >= 3;
  // OPE-1032 (ratified 2026-09-15) — genuinely season-long events: a Holiday
  // Market category, or a description that states the span itself ("November 7
  // through December 28"). Specimens: Snowport `2594da27` (Nov 7–Dec 28),
  // Christmas at Blithewold `bd8d3228` (Nov 24–Jan 3).
  const isStatedSeason =
    hasSeasonLongCategory(input.categories) || descriptionStatesMonthSpan(input.description);

  if (
    input.startDate &&
    input.endDate &&
    input.endDate.getTime() - input.startDate.getTime() > MAX_DURATION_MS_NON_MAJOR &&
    input.eventScale !== "MAJOR" &&
    !isRecurringSeries &&
    !isStatedSeason
  ) {
    // Multi-week storage of an event with no MAJOR scale tag. Most often
    // this is a recurring weekly market or seasonal series row that got
    // ingested as a single event with start=first occurrence and end=
    // last occurrence (Rhododendron Festival 11-day case, "open every
    // Saturday May–October" pattern). True multi-week single events
    // (e.g., state fairs) tag MAJOR and bypass this check; recurring
    // series tag discontinuousDates or carry ≥3 event_days.
    reasons.push("duration_too_long_for_scale");
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
}

// ---------------------------------------------------------------------------
// Unified evaluator — every ingest path calls this
// ---------------------------------------------------------------------------

export interface IngestEvaluationInput {
  name: string | null | undefined;
  sourceName?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  startDate: Date | null | undefined;
  endDate: Date | null | undefined;
  applicationDeadline?: Date | null | undefined;
  description?: string | null | undefined;
  /** Optional event_scale tag. When set to MAJOR, the duration-too-long
   *  plausibility check is bypassed (legitimately multi-week events
   *  like state fairs tag MAJOR). Omit for backwards compat with
   *  callers that don't yet pass scale. */
  eventScale?: string | null | undefined;
  /** True for recurring/periodic series (biweekly markets, season-spanning
   *  events). Bypasses the duration-too-long gate. See DateGateInput. */
  discontinuousDates?: boolean | null | undefined;
  /** Count of associated event_days rows. ≥3 also bypasses the
   *  duration-too-long gate. See DateGateInput. */
  eventDaysCount?: number | null | undefined;
  /** OPE-1032 — `events.categories` (JSON array string or array). A season-long
   *  category (Holiday Market) bypasses the duration-too-long gate. */
  categories?: string | readonly string[] | null | undefined;
}

export interface IngestEvaluationResult {
  /** APPROVED = route through normal status assignment (caller's default);
   *  PENDING_REVIEW = override editorial status to PENDING and persist
   *  reasons in events.gate_flags. */
  route: "APPROVED" | "PENDING_REVIEW";
  /** All firing reasons. Caller persists this as JSON.stringify(reasons)
   *  into events.gate_flags. Empty array means route === "APPROVED". */
  reasons: string[];
  /** Resolved credibility tier (1-3) for telemetry / audit. */
  tier: 1 | 2 | 3;
}

export function evaluateGates(input: IngestEvaluationInput): IngestEvaluationResult {
  const reasons: string[] = [];

  // Resolve tier from sourceUrl OR sourceName (sourceUrl is more specific
  // when both are present).
  const tier = sourceCredibilityTier(input.sourceUrl || input.sourceName);

  // Tier 3 is ALWAYS PENDING_REVIEW regardless of other gates. Add the
  // tier-3 reason first so admins see WHY the gate fired even if no
  // name/date patterns matched.
  if (tier === 3) {
    reasons.push("source_tier_3_aggregator");
  }

  const nameFlag = nameMatchesAdminFlag(input.name);
  if (nameFlag.matched) reasons.push(...nameFlag.reasons);

  const dateCheck = dateLooksImplausible({
    startDate: input.startDate,
    endDate: input.endDate,
    applicationDeadline: input.applicationDeadline,
    description: input.description,
    eventScale: input.eventScale,
    discontinuousDates: input.discontinuousDates,
    eventDaysCount: input.eventDaysCount,
    categories: input.categories,
  });
  if (!dateCheck.ok) reasons.push(...dateCheck.reasons);

  // Multi-row PDF flag — a city/civic venue calendar PDF lists many
  // events at the same venue across different organizers. AI extraction
  // can carry the previous row's organizer (or other context) forward
  // into the next row by mistake. We can't reliably detect this from
  // the extracted event alone; the most-tractable signal is the source
  // URL pattern. When a PDF on a known multi-row host is the source,
  // route to PENDING_REVIEW so admin verifies organizer + name +
  // dates row-by-row before approving. See feedback note on the NHAC
  // false-attribution case from the Concord NH Everett Arena PDF.
  if (input.sourceUrl && sourceLooksLikeMultirowPdf(input.sourceUrl)) {
    reasons.push("source_tabular_multirow_pdf");
  }

  return {
    route: reasons.length > 0 ? "PENDING_REVIEW" : "APPROVED",
    reasons,
    tier,
  };
}
