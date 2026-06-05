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
}

export type DateGateResult = { ok: true } | { ok: false; reasons: string[] };

const SAME_DAY_TOLERANCE_MS = 12 * 60 * 60 * 1000; // 12h — covers TZ jitter
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
  return Math.abs(a.getTime() - b.getTime()) < SAME_DAY_TOLERANCE_MS;
}

/** Pattern that catches mentions of a specific time-of-day in a description.
 *  When present, a non-midnight-UTC start_date is legitimately preserving the
 *  source's intended time; when absent, it's a likely timezone-confused parse
 *  of a date-only source field. Matches "2 PM", "14:30", "noon", "morning"
 *  (the latter signals intentional time semantics even if non-numeric). */
const DESCRIPTION_HAS_TIME_PATTERNS = [
  /\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(?:noon|midnight|morning|afternoon|evening|night)\b/i,
];

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
  if (!input.startDate) return false;
  const h = input.startDate.getUTCHours();
  const m = input.startDate.getUTCMinutes();
  const s = input.startDate.getUTCSeconds();

  // Noon UTC is the canonical anchor for date-only ingests
  // (normalizeEventDate). Always clean.
  if (h === 12 && m === 0 && s === 0) return false;

  // Midnight UTC is the A3 / K14 symptom — date-only ingest path
  // bypassed normalizeEventDate and parsed as midnight. Always
  // suspicious, even when the description mentions a time (a 5pm EDT
  // event would correctly store at 21:00:00 UTC, not 00:00:00).
  if (h === 0 && m === 0 && s === 0) return true;

  // Non-quarter-hour minutes or non-zero seconds don't correspond to
  // any human-meaningful event time. Always suspicious.
  if (m % 15 !== 0 || s !== 0) return true;

  // For other quarter-hour-aligned times (e.g. 18:00:00 = 2pm EDT,
  // 14:30:00 = 10:30am EDT), defer to the description.
  if (input.description) {
    const decoded = decodeHtmlEntities(input.description);
    if (DESCRIPTION_HAS_TIME_PATTERNS.some((p) => p.test(decoded))) {
      return false;
    }
  }
  return true;
}

export function dateLooksImplausible(input: DateGateInput): DateGateResult {
  const reasons: string[] = [];
  const now = new Date();

  if (dateLooksTimezoneConfused(input)) {
    // Gate A4: start_date stored off UTC-midnight, description has no time
    // mention. Likely a misparsed date-only source or a timestamp with a
    // non-UTC offset that wasn't normalized through parseDateOnly.
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

  if (input.endDate && input.endDate.getTime() < now.getTime()) {
    // Past end date for a newly-ingested event. The Cape Cod Chamber
    // failure mode: prior-year dates carried forward in the aggregator
    // feed. APPROVED past-end-date events are also caught by
    // confirm_past_event_occurrence post-fact, but flag here too so the
    // initial ingest doesn't silently insert stale data.
    reasons.push("end_date_in_past");
  }

  // Recurring-event exemption (analyst 2026-05-26 follow-up to PR #209):
  // a legitimately periodic series (Artisans' Market in Unity — biweekly
  // May–Dec, the three Farmington farmers markets — weekly season spans)
  // SHOULD have a long start→end span; that span is the season, not a
  // malformed single event. Either signal is sufficient evidence:
  //   - discontinuousDates flag set at ingest, OR
  //   - ≥3 event_days rows already persisted (admin PATCH path).
  const isRecurringSeries = input.discontinuousDates === true || (input.eventDaysCount ?? 0) >= 3;

  if (
    input.startDate &&
    input.endDate &&
    input.endDate.getTime() - input.startDate.getTime() > MAX_DURATION_MS_NON_MAJOR &&
    input.eventScale !== "MAJOR" &&
    !isRecurringSeries
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
