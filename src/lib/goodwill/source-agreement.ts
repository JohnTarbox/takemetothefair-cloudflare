/**
 * OPE-988 — does the page an event cites actually describe THIS event?
 *
 * ## The specimen
 *
 * `johnny-appleseed-arts-and-cultural-festival` is in Leominster, MA. Its
 * `source_url` was `https://www.johnnyappleseedfest.com/` — the Johnny Appleseed
 * Festival of **Fort Wayne, Indiana** ("1502 Harry W. Baals Dr. Ft. Wayne, IN
 * 46805", Sept. 19th & 20th). Live, 200, same name, same weekend, rich event
 * text. Every check we run passed it: `classifyUrlHealth` reads `ok`, the drift
 * sweep finds dates that match, and `findDuplicate` has nothing to say because
 * nothing else claims that URL. It was the wrong event, in the wrong state.
 *
 * ## The question, kept deliberately weak
 *
 * Not "is everything on this page consistent with our row" — that is an
 * extractor, and we already have one that needs a human beside it. Only:
 *
 *   1. Does the page name the event's TOWN or its VENUE anywhere?  → agrees.
 *   2. If not, does it name a DIFFERENT US state prominently — an address block
 *      (`Ft. Wayne, IN 46805`), `City, Indiana`, a JSON-LD `addressRegion`, or
 *      the state name more than once — while never naming ours?  → disagrees.
 *   3. Anything else — a thin page, a page that names no place at all, a page
 *      naming both states — is `null`: we cannot tell, and say so.
 *
 * The asymmetry is the design. A false "agrees" (a Bristol, CT page backing a
 * Bristol, RI event) costs nothing we do not already pay. A false "disagrees"
 * puts a row in front of an operator. So a town match alone wins, and the
 * disagreement bar needs positive evidence of somewhere else.
 *
 * ## ⚠️ What this does NOT do
 *
 * It never nulls `source_url`, never unpublishes. A disagreement becomes an
 * `event_discrepancies` row for a human; the corrected Johnny Appleseed row was
 * fixed by hand and that remains the only way this field changes.
 */
import { classifySource, isUnfetchableSource } from "@takemetothefair/utils";
import {
  containsPhrase,
  decodedVisibleText,
  metaContent,
  normalizeForMatch,
  pageTitle,
} from "./page-text";

export interface AgreementContext {
  eventName: string;
  /** The event's town — `venues.city`. */
  city?: string | null;
  /** Two-letter code or full name — `venues.state` ?? `events.state_code`. */
  state?: string | null;
  venueName?: string | null;
  /** When the venue row's city differs from `city` (rare; kept for callers). */
  venueCity?: string | null;
}

export interface AgreementResult {
  /** true = names our town/venue; false = names another state and not ours; null = cannot tell. */
  agrees: boolean | null;
  signals: string[];
  /** Other US states the page names prominently, as codes. For the discrepancy row. */
  otherStates: string[];
  detail: string;
}

/**
 * One disagreement as the sweep route returns it and the MCP workflow files it
 * (as an `existence` discrepancy). Mirrored in
 * mcp-server/src/goodwill/source-agreement-capture.ts — keep the two in step.
 */
export interface SourceDisagreement {
  eventId: string;
  slug: string;
  sourceUrl: string;
  city: string | null;
  state: string | null;
  venueName: string | null;
  otherStates: string[];
  signals: string[];
  detail: string;
}

export const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/**
 * Codes that are also ordinary English words in all-caps text ("OPEN IN THE
 * PARK", "RAIN OR SHINE", "ME & YOU", "CO."). Without a ZIP after them they are
 * not read as a state at all.
 *
 * `NE` is here from the read-only scan, not by analogy: franklinfarmri.org (a
 * Cumberland, RI farm) read `other-state:NE(comma-code)` — in New England "NE"
 * is the region far more often than Nebraska.
 */
const WORDLIKE_CODES = new Set([
  "IN",
  "OR",
  "ME",
  "OK",
  "HI",
  "DE",
  "ID",
  "OH",
  "CO",
  "LA",
  "AL",
  "PA",
  "MD",
  "MS",
  "MO",
  "NE",
]);

/**
 * State names that are also people, streets and newspapers ("George Washington",
 * "Virginia Smith", "Washington Street", "New York Times"). They still count in
 * an address shape (after a comma, or as JSON-LD), just never by repetition.
 */
const NAME_REPEAT_EXCLUDED = new Set(["WA", "GA", "VA", "NY", "DC"]);

/** Hosts that list many organizers' events: their page is not the organizer's. */
const LISTING_HOSTS = [
  "eventbrite.com",
  "allevents.in",
  "festivalnet.com",
  "10times.com",
  "google.com",
  "forms.gle",
  "eventeny.com",
  "humanitix.com",
  "gunshowtrader.com",
  "instagram.com",
  "linktr.ee",
  "mlsend.com",
];

/**
 * Is this URL an organizer's own page (the population this check is for)?
 * Aggregators come from the canonical `classifySource` list — not a second copy
 * — and Facebook from `isUnfetchableSource`.
 */
export function isOrganizerSourceUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (isUnfetchableSource(url)) return false;
  if (classifySource(null, url).ingestionMethod === "aggregator_import") return false;
  return !LISTING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function toStateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const s = state.trim();
  if (/^[A-Za-z]{2}$/.test(s) && US_STATES[s.toUpperCase()]) return s.toUpperCase();
  const hit = Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : null;
}

/** Words that name no particular place ("Town Common", "Downtown", "Fairgrounds"). */
const GENERIC_PLACE_WORDS = new Set(
  (
    "the of at and a downtown town city village common green park fairgrounds fairground grounds " +
    "center centre community hall school high middle church square street main field neighborhood " +
    "porches porch market area state memorial public library museum farm event events venue various " +
    "locations location online virtual tbd tba"
  ).split(" ")
);

function venueCandidates(venueName: string | null | undefined): string[] {
  if (!venueName) return [];
  const out: string[] = [];
  const paren = /\(([^)]*)\)/.exec(venueName);
  const bare = venueName.replace(/\([^)]*\)/g, " ").trim();
  for (const c of [bare, paren?.[1] ?? ""]) {
    const norm = normalizeForMatch(c).trim();
    if (norm.length < 6) continue;
    const toks = norm.split(" ");
    if (toks.every((t) => GENERIC_PLACE_WORDS.has(t))) continue;
    out.push(c);
  }
  return out;
}

/** Below this, a page has not said enough to disagree with anything. */
const MIN_TEXT = 200;

interface StateMention {
  code: string;
  how: "address" | "comma-code" | "comma-name" | "jsonld" | "name-repeated";
}

/**
 * Every state the text names in a way that reads as a LOCATION rather than a
 * word. Exported for the unit tests that pin each shape.
 */
export function prominentStateMentions(text: string, jsonLdRegions: string[] = []): StateMention[] {
  const found = new Map<string, StateMention>();
  const add = (code: string, how: StateMention["how"]) => {
    if (!found.has(code)) found.set(code, { code, how });
  };

  // `…, IN 46805` — the address block. Case-sensitive: codes are capitals.
  for (const m of text.matchAll(/,\s*([A-Z]{2})\.?\s+\d{5}(?:-\d{4})?\b/g)) {
    if (US_STATES[m[1]]) add(m[1], "address");
  }
  // `Fort Wayne, IN` with no ZIP — only for codes that are not also words.
  for (const m of text.matchAll(/[A-Za-z.]\s*,\s*([A-Z]{2})\b(?![A-Za-z])/g)) {
    if (US_STATES[m[1]] && !WORDLIKE_CODES.has(m[1])) add(m[1], "comma-code");
  }
  // `Fort Wayne, Indiana` / repeated `Indiana`. Longest names first so
  // "West Virginia" is not also read as "Virginia".
  const byLength = Object.entries(US_STATES).sort((a, b) => b[1].length - a[1].length);
  let rest = text;
  for (const [code, name] of byLength) {
    const re = new RegExp(`(,\\s*)?\\b${name.replace(/ /g, "\\s+")}\\b`, "gi");
    const hits = [...rest.matchAll(re)];
    if (hits.length === 0) continue;
    if (hits.some((h) => h[1])) add(code, "comma-name");
    else if (hits.length >= 2 && !NAME_REPEAT_EXCLUDED.has(code)) add(code, "name-repeated");
    rest = rest.replace(re, " ");
  }
  for (const r of jsonLdRegions) {
    const code = toStateCode(r);
    if (code) add(code, "jsonld");
  }
  return [...found.values()];
}

function jsonLdValues(html: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,120})"`, "gi");
  for (const block of html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    for (const m of block[1].matchAll(re)) out.push(m[1]);
  }
  return out;
}

export function checkSourceAgreement(html: string | null, ctx: AgreementContext): AgreementResult {
  const signals: string[] = [];
  if (!html) {
    return { agrees: null, signals: ["no-body"], otherStates: [], detail: "no page body" };
  }

  const title = pageTitle(html);
  const body = decodedVisibleText(html);
  const description = metaContent(html, "description") ?? "";
  const localities = jsonLdValues(html, "addressLocality");
  const streets = jsonLdValues(html, "streetAddress");
  const regions = jsonLdValues(html, "addressRegion");
  const text = `${title} . ${description} . ${body}`;

  if (`${title} ${body}`.trim().length < MIN_TEXT) {
    return {
      agrees: null,
      signals: ["too-little-text"],
      otherStates: [],
      detail: `only ${`${title} ${body}`.trim().length} chars of text; cannot judge`,
    };
  }

  const haystack = normalizeForMatch(`${text} ${localities.join(" ")} ${streets.join(" ")}`);

  const towns = [ctx.city, ctx.venueCity].filter(
    (t): t is string => typeof t === "string" && normalizeForMatch(t).trim().length >= 3
  );
  const namedTown = towns.find((t) => containsPhrase(haystack, t));
  if (namedTown) signals.push(`named-town:${namedTown}`);
  const namedVenue = venueCandidates(ctx.venueName).find((v) => containsPhrase(haystack, v));
  if (namedVenue) signals.push(`named-venue:${namedVenue}`);

  const ownCode = toStateCode(ctx.state);
  const mentions = prominentStateMentions(text, regions);
  const own = ownCode ? mentions.find((m) => m.code === ownCode) : undefined;
  const others = mentions.filter((m) => m.code !== ownCode);
  if (own) signals.push(`own-state:${own.code}(${own.how})`);
  for (const o of others) signals.push(`other-state:${o.code}(${o.how})`);
  const otherStates = others.map((o) => o.code);

  if (namedTown || namedVenue) {
    return {
      agrees: true,
      signals,
      otherStates,
      detail: `page names the event's ${namedTown ? `town "${namedTown}"` : `venue "${namedVenue}"`}`,
    };
  }

  if (!ownCode) {
    signals.push("no-event-state");
    return {
      agrees: null,
      signals,
      otherStates,
      detail: "event has no state to compare against, and the page names neither town nor venue",
    };
  }

  if (others.length > 0 && !own) {
    return {
      agrees: false,
      signals,
      otherStates,
      detail:
        `page never names ${towns[0] ?? "the event's town"}${ctx.venueName ? ` or "${ctx.venueName}"` : ""}` +
        ` and places itself in ${others.map((o) => US_STATES[o.code]).join(", ")}, not ${US_STATES[ownCode]}`,
    };
  }

  signals.push(own ? "own-state-only" : "no-location-evidence");
  return {
    agrees: null,
    signals,
    otherStates,
    detail: own
      ? `page names ${US_STATES[ownCode]} but not the event's town or venue`
      : "page names no town, venue or state we can compare",
  };
}
