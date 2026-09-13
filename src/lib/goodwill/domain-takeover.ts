/**
 * OPE-988 — has an organizer's domain been taken over by someone else?
 *
 * ## The specimen
 *
 * `leominster-rotary.org` (2026-09-13) answers 200 — after a redirect to
 * `sidneypoolstoday.com` — with an Indonesian lottery page: title "Keluaran SDY
 * Pools: Togel Sidney…", `<html lang="id">`, `meta geo.region="ID"`,
 * `meta author="TOGEL SIDNEY"`, links to `togelsdy.sidneypoolstoday.com`.
 * Search results still show the old Rotary title, so nothing a human glances at
 * gives it away, and every status-code check we have passes it.
 *
 * `classifyUrlHealth` can call a page like this `ok` outright: the lottery page
 * carries month names, years and the word "schedule" (draw times), which are
 * exactly its two-signal bar. Event-shaped text is not evidence of an EVENT
 * page when the whole page is about something else.
 *
 * ## Why several independent signals, and which may stand alone
 *
 * Each signal on its own has an innocent explanation somewhere in our estate:
 *
 *   - "casino", "lottery", "poker" — a Lions Club casino night, a booth lottery,
 *     a poker run, an expo at Mohegan Sun. WEAK: never enough alone.
 *   - a title sharing no word with the entity — "Home", or an org whose site is
 *     titled by its tagline. Structural: corroborates, never decides.
 *   - a redirect to another registrable domain — an organization that moved.
 *     Structural: corroborates, never decides.
 *   - `lang="fr"` — an Acadian festival. Only counts when the page ALSO has
 *     almost no English in it.
 *
 * So the verdict needs two independent families, at least one of which is
 * about the page's CONTENT (keywords, geo, language, spam links) rather than its
 * shape. The one exception is a keyword that has no innocent reading on a New
 * England event site — "togel", "slot gacor", "viagra" — appearing in the
 * `<title>`: that alone is decisive, because the title is what the site says it
 * IS, and no legitimate organizer titles its site that way.
 *
 * ## ⚠️ What this does NOT do
 *
 * It never acts. A verdict lands in `url_health_checks` for an operator and a
 * warn log; nothing nulls a website or unpublishes an event on it.
 */
import type { UrlHealthVerdict } from "./url-health";
import {
  containsPhrase,
  decodedVisibleText,
  headings,
  hrefs,
  htmlLang,
  metaContent,
  normalizeForMatch,
  pageTitle,
} from "./page-text";

/** Verdicts a sweep may record: the url-health set plus this module's. */
export type SweepVerdict = UrlHealthVerdict | "domain_takeover";

/** A takeover is always worth an operator's look. */
export function isSweepActionable(verdict: SweepVerdict, base: (v: UrlHealthVerdict) => boolean) {
  return verdict === "domain_takeover" || base(verdict);
}

export interface TakeoverOptions {
  /** The promoter or event name the URL is supposed to belong to. */
  entityName: string | null;
  /** Other names the same entity goes by (e.g. an event's promoter). */
  aliases?: Array<string | null | undefined>;
  /** The URL we asked for, and where redirects left us. Both optional. */
  requestedUrl?: string | null;
  finalUrl?: string | null;
}

export interface TakeoverResult {
  takenOver: boolean;
  signals: string[];
  detail: string;
}

type SpamClass = "gambling" | "pharma" | "adult";

/**
 * No innocent reading on a US event site. Deliberately narrow: every entry is
 * either a lottery/slot term from the Indonesian SEO-spam ecosystem that has
 * produced both of our hijack specimens (Clinton Lions `Situs Slot Gacor`,
 * Leominster Rotary `Togel Sidney`), or a pharma/adult spam staple.
 */
const STRONG: Record<SpamClass, RegExp> = {
  gambling:
    /\b(togel|gacor|sbobet|maxwin|situs\s+slot|slot\s+online|online\s+slots?|judi\s+(online|bola|slot)|bandar\s+(togel|bola|judi|slot)|(keluaran|pengeluaran|result|data|live\s+draw)\s+(sdy|hk|sgp|macau|toto)|toto\s+(sdy|hk|sgp|macau)|online\s+casino|casino\s+online)\b/i,
  pharma:
    /\b(viagra|cialis|levitra|kamagra|online\s+pharmacy|buy\s+(tramadol|xanax|oxycodone|adderall))\b/i,
  adult: /\b(porn|pornhub|onlyfans\s+leaks?)\b/i,
};

/**
 * Real words on real fair sites. A hit here is ONE signal and never a verdict:
 * "Casino Night", "booth lottery", "poker run", "Mohegan Sun casino".
 */
const WEAK: Record<SpamClass, RegExp> = {
  gambling: /\b(casino|poker|betting|sportsbook|lottery|lotto|jackpot|slots|baccarat|roulette)\b/i,
  pharma: /\b(pharmacy|pills)\b/i,
  adult: /\b(escorts?)\b/i,
};

/** A host label that is only ever a spam network's. */
const SPAM_HOST_RE = /(togel|gacor|sbobet|judi|casino|poker|slot|viagra|cialis)/i;

const ENGLISH_FUNCTION_WORDS = new Set(
  "the and of to in for is on with at by our your you we are will this from be or as it an all more".split(
    " "
  )
);

/** Words that say nothing about WHOSE page it is. */
const NON_IDENTIFYING = new Set(
  (
    "the a an and of for to in on at by with our your home welcome official site website web page index " +
    "inc llc co corp org com net events event calendar news about contact us info information " +
    "annual first new"
  ).split(" ")
);

function meaningfulTokens(s: string): string[] {
  return normalizeForMatch(s)
    .trim()
    .split(" ")
    .filter((t) => t.length >= 3 && !NON_IDENTIFYING.has(t) && !/^\d+$/.test(t));
}

function registrable(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .split(".");
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

/** Fraction of words that are common English function words. */
export function englishRatio(text: string): { ratio: number; words: number } {
  const words = normalizeForMatch(text).trim().split(" ").filter(Boolean);
  if (words.length === 0) return { ratio: 0, words: 0 };
  const hits = words.filter((w) => ENGLISH_FUNCTION_WORDS.has(w)).length;
  return { ratio: hits / words.length, words: words.length };
}

export function detectDomainTakeover(html: string | null, opts: TakeoverOptions): TakeoverResult {
  if (!html) return { takenOver: false, signals: [], detail: "no body to read" };

  const title = pageTitle(html);
  const meta = [
    metaContent(html, "description"),
    metaContent(html, "og:title"),
    metaContent(html, "og:description"),
    metaContent(html, "author"),
  ]
    .filter(Boolean)
    .join(" | ");
  const heads = headings(html).join(" | ");
  const body = decodedVisibleText(html);

  const content: string[] = [];
  const structural: string[] = [];
  let decisive: string | null = null;

  // ── 1. keyword classes ────────────────────────────────────────────────
  let keywordSignal: string | null = null;
  for (const cls of Object.keys(STRONG) as SpamClass[]) {
    const inTitle = STRONG[cls].exec(title);
    if (inTitle) {
      decisive = `spam-title:${cls}`;
      keywordSignal = `spam-title:${cls}`;
      break;
    }
    if (!keywordSignal && (STRONG[cls].test(heads) || STRONG[cls].test(meta))) {
      keywordSignal = `spam-heading:${cls}`;
    }
  }
  if (!keywordSignal) {
    for (const cls of Object.keys(WEAK) as SpamClass[]) {
      if (WEAK[cls].test(title) || WEAK[cls].test(heads)) {
        keywordSignal = `weak-keyword:${cls}`;
        break;
      }
    }
  }
  // One keyword family, however many classes hit: title, headings and meta are
  // the same author saying the same thing, not independent witnesses.
  if (keywordSignal) content.push(keywordSignal);

  // ── 2. geo.region names a country that is not the US ─────────────────
  const geo = metaContent(html, "geo.region");
  if (geo) {
    const country = geo.split(/[-_]/)[0].trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country) && country !== "US") content.push(`geo-region:${country}`);
  }

  // ── 3. declared non-English, and the page really is not in English ───
  const lang = htmlLang(html) ?? metaContent(html, "content-language")?.toLowerCase() ?? null;
  const primary = lang ? lang.split(/[-_]/)[0] : null;
  const eng = englishRatio(`${title} ${heads} ${body}`);
  if (primary && primary !== "en") {
    if (eng.words < 80 || eng.ratio < 0.05) content.push(`language:${primary}`);
  } else if (!primary && eng.words >= 200 && eng.ratio < 0.03) {
    content.push("language:non-english-text");
  }

  // ── 4. outbound links into a spam network ─────────────────────────────
  const self = registrable(opts.finalUrl ?? opts.requestedUrl);
  const spamHosts = new Set<string>();
  for (const h of hrefs(html)) {
    let host: string;
    try {
      host = new URL(h, "https://placeholder.invalid/").hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === "placeholder.invalid") continue;
    if (SPAM_HOST_RE.test(host)) spamHosts.add(host);
  }
  // Two DISTINCT hosts, so one sponsor link to a casino resort is not enough.
  // The page's own host counts: a lottery site linking to its own subdomains is
  // exactly the specimen (togelsdy.sidneypoolstoday.com).
  if (spamHosts.size >= 2 || (spamHosts.size === 1 && self && SPAM_HOST_RE.test(self))) {
    content.push(`spam-links:${spamHosts.size}`);
  }

  // ── 5. the title does not name the entity at all (structural) ────────
  const names = [opts.entityName, ...(opts.aliases ?? [])].filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0
  );
  const titleTokens = meaningfulTokens(title);
  if (names.length > 0 && titleTokens.length >= 2) {
    const titleNorm = normalizeForMatch(title);
    const titleCompact = titleNorm.replace(/ /g, "");
    const overlaps = names.some((n) => {
      const toks = meaningfulTokens(n);
      if (toks.some((t) => containsPhrase(titleNorm, t))) return true;
      const compact = normalizeForMatch(n).replace(/ /g, "");
      return compact.length >= 6 && titleCompact.includes(compact);
    });
    if (!overlaps && names.some((n) => meaningfulTokens(n).length > 0)) {
      structural.push("title-no-entity-token");
    }
  }

  // ── 6. redirected onto another registrable domain (structural) ───────
  const from = registrable(opts.requestedUrl);
  const to = registrable(opts.finalUrl);
  if (from && to && from !== to) structural.push(`cross-domain-redirect:${to}`);

  const signals = [...content, ...structural];
  const takenOver = decisive !== null || (signals.length >= 2 && content.length >= 1);

  const detail = takenOver
    ? `domain takeover: ${signals.join(", ")}${title ? `; title "${title.slice(0, 120)}"` : ""}`
    : signals.length === 0
      ? "no takeover signal"
      : `insufficient takeover evidence (${signals.join(", ")})`;

  return { takenOver, signals, detail };
}
