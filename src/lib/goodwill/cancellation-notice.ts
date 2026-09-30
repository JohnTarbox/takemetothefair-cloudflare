/**
 * OPE-987 — does an organizer's page ANNOUNCE that the event is off?
 *
 * ## The failure this exists to catch
 *
 * `cape-cod-brew-fest` was served as SCHEDULED for ~39 days after
 * capecodbrewfest.com published "2026 Festival Canceled" (page
 * `article:modified_time` 2026-08-04). Nothing re-read organizer pages for
 * cancellation, and every check we did have said the event was on: the same
 * page still renders its 2026 "Attending Breweries" / "Attending Vendors"
 * sections, so an "is there event content" test (url-health.ts `ok`) passes.
 * The notice and the roster sit on one page, and only one of them is news.
 *
 * ## What this reads, and why only there
 *
 * Four regions, in the order a person scanning the page would see them:
 *
 *   title    — `<title>`
 *   heading  — `<h1>`..`<h4>` text. h4 is one past the ticket's h1–h3 because
 *              the specimen's own "2026 Festival Cancelled" is an `<h4>`.
 *   meta     — `description` / `og:description` / `twitter:description`
 *   body     — the first BODY_LEAD_CHARS of visible text, AFTER the roster /
 *              list regions are removed (see stripRosterRegions)
 *
 * An announcement that the event is off is made prominently. Reading the whole
 * page instead would reach footers, FAQs and vendor terms, which is exactly
 * where "cancellation policy" boilerplate lives.
 *
 * ## ⚠️ What this deliberately does NOT do
 *
 * It never decides the event IS cancelled. A hit becomes an operator-review
 * discrepancy (cancellation-recheck.ts); nothing flips `lifecycle_status`. A
 * partial cancellation ("Saturday's parade is cancelled") also matches, and
 * that is a reason to look, not a reason to cancel the fair.
 *
 * Pure: no I/O, no clock. Importable from the MCP Worker by relative path.
 */

export type CancellationScope = "year" | "series" | "unclear";
export type CancellationRegion = "title" | "heading" | "meta" | "body";

export interface CancellationHit {
  region: CancellationRegion;
  /** The matched phrase as written on the page. */
  phrase: string;
  /** The sentence it came from, trimmed — for an operator, not for logic. */
  sentence: string;
  scope: CancellationScope;
}

export interface CancellationNoticeResult {
  matched: boolean;
  /** The first hit's phrase, in region order (title → heading → meta → body). */
  phrase: string | null;
  scope: CancellationScope | null;
  /** Every distinct scope the hits carried — `["year","series"]` on Cape Cod. */
  scopes: CancellationScope[];
  hits: CancellationHit[];
}

export interface DetectCancellationOptions {
  /**
   * The edition we list (the event row's start-date year). When given, a
   * sentence that names OTHER years and not this one is history ("the 2020
   * and 2021 fairs were cancelled"), not news, and is discarded.
   */
  eventYear?: number;
}

/** How much of the body a notice has to appear within. */
export const BODY_LEAD_CHARS = 1500;

/**
 * Edition-level announcement vocabulary. Explicit words only: the ticket's
 * list, spelled both ways the specimen spells it ("Canceled" and "Cancelled").
 */
const CANCEL_RE =
  /\b(cancel(?:l)?ed|cancel(?:l)?ation|cancel(?:l)?ing|cancel\s+the|postponed|will\s+not\s+be\s+held|won[’']?t\s+be\s+held|no\s+longer\s+taking\s+place|(?:has|have)\s+been\s+called\s+off|called\s+off)\b/i;

/**
 * Series-level announcement vocabulary — the organizer is ending the event,
 * not one edition. The specimen's meta description says it this way and never
 * uses the word "cancel": "we have made the difficult decision to end the Cape
 * Cod Brew Fest".
 *
 * ⚠️ "final year" is NOT here on its own. "2026 will be our final year!" on a
 * page for an upcoming event means the event IS happening. It is a series cue
 * (SERIES_CUE_RE) that only colours a sentence that already announces
 * something.
 */
const SERIES_END_RE =
  /\b((?:decision|decided)\s+to\s+(?:end|discontinue|retire)\s+(?:the|our)|(?:will\s+)?no\s+longer\s+be\s+held|(?:has|have)\s+been\s+discontinued|will\s+not\s+(?:be\s+)?return(?:ing)?)\b/i;

/** Corroborates series scope inside a sentence that already matched. */
const SERIES_CUE_RE =
  /\b(final\s+(?:year|festival|fair|show|event)|for\s+good|permanently|indefinitely|end\s+(?:the|our)\b|no\s+longer\s+be\s+held|will\s+not\s+return)/i;

/**
 * Boilerplate that uses the vocabulary without announcing anything. A sentence
 * matching any of these is discarded whole.
 *
 * Each arm is a shape seen on real fair pages, not a guess at one:
 *   - policy nouns: "Cancellation Policy", "cancellation fee/deadline"
 *   - conditionals: "if the event is cancelled due to weather…", "in the event
 *     of cancellation", "may be cancelled", "subject to cancellation"
 *   - denials: "rain or shine", "no cancellations", "will not be cancelled"
 *   - the reader's own action: "cancel your booth / registration / order"
 *   - rain dates: "postponed to the rain date"
 *   - history: COVID-era cancellations, the commonest past-tense mention
 */
const BOILERPLATE_RE = new RegExp(
  [
    String.raw`cancel(?:l)?ation\s+(?:and\s+refund\s+)?(?:policy|policies|fees?|deadlines?|requests?|terms|charges?)`,
    String.raw`refund\s+(?:and\s+cancel(?:l)?ation\s+)?polic(?:y|ies)`,
    String.raw`\b(?:if|should|unless|whether)\b[^.]{0,80}\b(?:cancel|postpon)`,
    String.raw`\bin\s+(?:the\s+)?(?:event|case)\s+(?:of|that)\b`,
    // "may be cancelled", and guilfordfair.org's "may be altered or canceled"
    String.raw`\b(?:may|might|could|can)\s+be\s+(?:\w+\s+(?:or|and\/or)\s+)?(?:cancel|postpon|called\s+off)`,
    // coggeshallfarm.org / guilfordfair.org (2026-09-13): "subject to change
    // and/or cancellation due to weather"
    String.raw`\bsubject\s+to\s+(?:change\s+(?:and\/or|or|and)\s+)?cancel`,
    String.raw`\breserves?\s+the\s+right\b`,
    String.raw`\brain\s+or\s+shine\b`,
    String.raw`\bno\s+cancel(?:l)?ations?\b`,
    String.raw`\b(?:will|would|is|are|was|were)\s+not\s+be(?:en)?\s+cancel`,
    String.raw`\bnever\s+(?:been\s+)?cancel`,
    String.raw`\bcancel\s+(?:your|an?|my|their|his|her)\s+(?:order|registration|booth|reservation|tickets?|subscription|application|space|spot|entry|account)`,
    String.raw`\brain\s+date\b`,
    String.raw`\b(?:covid|covid-19|pandemic|coronavirus)\b`,
    // Generic disclaimers about events in general, not this one. Seen on a
    // listing page in the 2026-09-13 measurement: "Some events do get
    // cancelled or postponed due to various reasons."
    String.raw`\b(?:some|many)\s+events\b`,
    String.raw`\b(?:do|does|can|sometimes)\s+get\s+(?:cancel|postpon)`,
  ].join("|"),
  "i"
);

const YEAR_RE = /\b20[0-9]{2}\b/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8217;|&#x2019;|&rsquo;/gi, "’")
    .replace(/&#8216;|&#x2018;|&lsquo;/gi, "‘")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—");
}

/** Tag-stripped inline text of an HTML fragment. */
function inlineText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function titleText(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? inlineText(m[1]) : "";
}

function metaDescriptions(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (
      !/\b(?:name|property)\s*=\s*["'](?:description|og:description|twitter:description)["']/i.test(
        tag
      )
    ) {
      continue;
    }
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const text = c ? inlineText(c[1] ?? c[2] ?? "") : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** Markup that is never prose: removed with its contents. */
function stripNonProse(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

/**
 * Words that head a roster: who is coming, not whether it is happening.
 * "Attending Breweries", "Participating Vendors", "Our Exhibitors", "Lineup".
 */
const ROSTER_HEADING_RE =
  /^(?:(?:attending|participating|featured|our|confirmed|20\d\d|this\s+year[’']?s)\s+)*(?:vendors?|breweries|brewers?|wineries|distilleries|exhibitors?|artists?|artisans?|crafters?|makers?|sponsors?|performers?|bands?|musicians?|entertainment|food\s+trucks?|merchants?|dealers?|lineup|line-up)\b/i;

/**
 * Remove regions whose content is a LIST, before the body lead is measured.
 *
 * Two jobs, and the tests pin both:
 *
 *  1. A roster must not SUPPRESS a notice. The body lead is a fixed window; a
 *     page that renders 200 vendor names above its announcement would push the
 *     announcement out of it. That is the Cape Cod shape made worse: a live
 *     2026 roster next to a notice that the 2026 festival is off.
 *  2. A roster must not RAISE one. A schedule list with "Sunday pancake
 *     breakfast — cancelled" or a vendor named "Cancel Culture Coffee" is not
 *     an announcement about the event.
 *
 * Removed: `<nav>`, `<ul>`, `<ol>`, `<dl>`, `<table>`, `<select>`, `<form>`,
 * `<footer>`, and from any heading matching ROSTER_HEADING_RE up to the next
 * heading of the same or a higher level.
 */
export function stripRosterRegions(html: string): string {
  let out = html;
  for (let i = 0; i < 3; i++) {
    // Repeated because lists nest; a non-greedy match closes at the inner tag.
    out = out.replace(/<(nav|ul|ol|dl|table|select|form|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  }
  // Roster sections headed by a roster heading.
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const cuts: Array<[number, number]> = [];
  const heads = [...out.matchAll(headingRe)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    level: Number(m[1]),
    text: inlineText(m[2]),
  }));
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!ROSTER_HEADING_RE.test(h.text)) continue;
    const next = heads.slice(i + 1).find((n) => n.level <= h.level);
    cuts.push([h.start, next ? next.start : out.length]);
  }
  for (const [s, e] of cuts.reverse()) out = out.slice(0, s) + " " + out.slice(e);
  return out;
}

/** Visible text with BLOCK boundaries kept as newlines, so sentences stay apart. */
function blockText(html: string): string {
  const noHead = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  return decodeEntities(
    noHead
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        /<\/?(p|div|section|article|header|main|aside|h[1-6]|li|tr|td|th|blockquote|figure|figcaption)\b[^>]*>/gi,
        "\n"
      )
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}

function headingTexts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = inlineText(m[2]);
    if (t) out.push(t);
  }
  return out;
}

/** Split a block of text into sentence-sized units. */
function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function classifySentence(
  sentence: string,
  region: CancellationRegion,
  opts: DetectCancellationOptions
): CancellationHit | null {
  const cancel = CANCEL_RE.exec(sentence);
  const seriesEnd = SERIES_END_RE.exec(sentence);
  const m = cancel ?? seriesEnd;
  if (!m) return null;
  if (BOILERPLATE_RE.test(sentence)) return null;

  const years = new Set((sentence.match(YEAR_RE) ?? []).map(Number));
  if (opts.eventYear !== undefined && years.size > 0 && !years.has(opts.eventYear)) {
    // Names other editions and not ours: history, not an announcement.
    return null;
  }

  let scope: CancellationScope;
  if (years.size > 0) {
    // "2026 Festival Canceled", "cancel the 2026 Cape Cod Brew Fest".
    scope = "year";
  } else if (seriesEnd || SERIES_CUE_RE.test(sentence)) {
    // "decision to end the Cape Cod Brew Fest" — no year, the whole event.
    scope = "series";
  } else {
    // "Festival Cancelled" — off, but the page does not say which editions.
    scope = "unclear";
  }
  return { region, phrase: m[0], sentence: sentence.slice(0, 300), scope };
}

export function detectCancellationNotice(
  html: string | null | undefined,
  opts: DetectCancellationOptions = {}
): CancellationNoticeResult {
  const empty: CancellationNoticeResult = {
    matched: false,
    phrase: null,
    scope: null,
    scopes: [],
    hits: [],
  };
  if (!html) return empty;

  const prose = stripNonProse(html);
  const regions: Array<[CancellationRegion, string[]]> = [
    ["title", [titleText(html)]],
    ["heading", headingTexts(stripRosterRegions(prose))],
    ["meta", metaDescriptions(html)],
    ["body", [blockText(stripRosterRegions(prose)).slice(0, BODY_LEAD_CHARS)]],
  ];

  const hits: CancellationHit[] = [];
  for (const [region, blocks] of regions) {
    for (const block of blocks) {
      for (const s of sentences(block)) {
        const hit = classifySentence(s, region, opts);
        if (hit) hits.push(hit);
      }
    }
  }
  if (hits.length === 0) return empty;

  const scopes = [...new Set(hits.map((h) => h.scope))];
  // Scope resolution.
  //
  // One scope across every hit → that scope.
  //
  // `year` AND `series` together → `unclear`, and this is the Cape Cod case.
  // Its body says "cancel the 2026 Cape Cod Brew Fest" (year) and its meta
  // description says "decision to end the Cape Cod Brew Fest" (series). Both
  // are true readings of one announcement, and they call for different
  // operator actions: `year` cancels one row, `series` also retires the
  // series and every future edition we might roll over. Picking either would
  // silently decide that for the operator, so the verdict says the page is
  // ambiguous and `scopes` keeps both readings for the discrepancy row.
  //
  // `unclear` mixed with exactly one definite scope → the definite one: an
  // undated "Festival Cancelled" heading next to "cancel the 2026 festival" is
  // the same announcement, dated once.
  const definite = scopes.filter((s) => s !== "unclear");
  const scope: CancellationScope = definite.length === 1 ? definite[0] : "unclear";

  return { matched: true, phrase: hits[0].phrase, scope, scopes, hits };
}
