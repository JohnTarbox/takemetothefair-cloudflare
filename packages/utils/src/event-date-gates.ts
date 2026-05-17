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

// Patterns that surface as flags. Each regex is documented inline with the
// failure mode it guards against. Tests in __tests__/event-date-gates.test.ts.
const NAME_PATTERNS: { reason: string; pattern: RegExp }[] = [
  // "CALL FOR ARTISTS", "Call for Vendors", "Call for Submissions"
  { reason: "name_call_for_pattern", pattern: /\bcall for\b/i },
  // "Vendor REGISTRATION Open", "Registration Now Available"
  { reason: "name_registration_pattern", pattern: /\bregistration\b/i },
  // "Apply Today", "Vendor Applications Open" — distinct from "apply" inside
  // a longer word like "application". \b on both sides.
  { reason: "name_apply_pattern", pattern: /\bapply\b/i },
  // Em-dash sub-venue suffix: "Concord Arts Festival — Arts Alley" indicates
  // a sub-component, not a top-level event. Hyphen and en-dash are NOT
  // flagged (those appear in normal names like "rock-n-roll").
  { reason: "name_em_dash_subvenue", pattern: /\s—\s/ },
];

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
  const reasons = NAME_PATTERNS.filter((p) => p.pattern.test(decoded)).map((p) => p.reason);
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
}

export type DateGateResult = { ok: true } | { ok: false; reasons: string[] };

const SAME_DAY_TOLERANCE_MS = 12 * 60 * 60 * 1000; // 12h — covers TZ jitter
const MAX_FUTURE_MS = 18 * 30 * 86400 * 1000; // ~18 months
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

/** Gate A4 (analyst spec 2026-05-16): catches the date-only-misparsed-as-
 *  timestamp bug. When a source provides a date-only ISO ("2026-07-15") or
 *  a date with an explicit non-UTC zone ("2026-07-15T20:00:00-04:00") and
 *  the ingest path doesn't normalize through parseDateOnly, the stored
 *  start_date can end up on a different UTC calendar day than the source
 *  intended. We can't see the original string here, but we CAN detect the
 *  shape: stored start_date with non-zero UTC h/m/s AND no time-of-day
 *  mention in the description (which would justify a non-midnight value). */
function dateLooksTimezoneConfused(input: DateGateInput): boolean {
  if (!input.startDate) return false;
  const offUtcMidnight =
    input.startDate.getUTCHours() !== 0 ||
    input.startDate.getUTCMinutes() !== 0 ||
    input.startDate.getUTCSeconds() !== 0;
  if (!offUtcMidnight) return false;
  if (input.description) {
    const decoded = decodeHtmlEntities(input.description);
    if (DESCRIPTION_HAS_TIME_PATTERNS.some((p) => p.test(decoded))) {
      // Description names a specific time — non-midnight-UTC is legitimate.
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
  });
  if (!dateCheck.ok) reasons.push(...dateCheck.reasons);

  return {
    route: reasons.length > 0 ? "PENDING_REVIEW" : "APPROVED",
    reasons,
    tier,
  };
}
