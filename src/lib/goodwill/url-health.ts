/**
 * OPE-860 — is the organizer URL we publish still the organizer's page?
 *
 * ## The failure this exists to catch
 *
 * Domains outlive the organizations that registered them. Two specimens found
 * in ONE 7-day window (OPE-857):
 *
 *   - `ledyardfair.org` — Ledyard Fair Inc dissolved 18 Nov 2024 (its own final
 *     IRS Form 990). The domain now serves a content site calling itself "The
 *     official information hub for the annual Ledyard Fair" with **no dates, no
 *     hours, no admission, no vendor terms** — fair-shaped prose with no fair in
 *     it. It sat in `promoters.website` for three days after the ticket that
 *     caught it, rendering as that promoter's official website.
 *   - `clintonlionsagfair207.com` — hijacked to gambling SEO spam, while its
 *     `meta-keywords` are still the fair's own from 2019. The old site's shell,
 *     contents replaced.
 *
 * **Both return HTTP 200.** Every liveness check we had is a status-code check,
 * so both pass. The failure is semantic, not transport-level.
 *
 * ## Why a verdict enum and not a boolean
 *
 * `fetchCanonicalDate` in the drift sweep collapsed FOUR outcomes into one
 * `{canonicalStartDate: null, htmlExcerpt: null}`:
 *
 *   - a non-2xx response            (route.ts:77)
 *   - 200 with no readable date     (route.ts:102)
 *   - a thrown fetch: DNS, timeout  (route.ts:104)
 *   - an aborted fetch
 *
 * All four then classify as `"fetch-failed"` and increment one counter. So a
 * domain that has been sold to a casino affiliate is **byte-identical, in our
 * data, to a network hiccup** — and the casino is the one that repeats every
 * day while nobody looks at a counter.
 *
 * `no_event_signal` is the verdict that did not exist. It is the whole point.
 *
 * ## ⚠️ What this deliberately does NOT do
 *
 * It does not decide the page is WRONG, only that it carries no evidence of
 * being an event page at all. A real organizer site that renders its dates in
 * an image, or behind JS, will read `no_event_signal` — which is why the
 * verdict feeds a review queue and must never drive an automatic unpublish.
 * The asymmetry is deliberate: a false `no_event_signal` costs an operator a
 * glance, and a false `ok` is how we keep publishing a link to a casino.
 */

/**
 * What we learned by looking at the URL.
 *
 * Ordered from "we saw the page and it was fine" to "we could not see it".
 * `no_event_signal` sits between: we saw it perfectly well, and there was no
 * event on it.
 */
export type UrlHealthVerdict =
  /** 2xx, and the page carries at least one event signal. */
  | "ok"
  /** 2xx, real HTML, and NOTHING on it says "event". The repurposed-domain case. */
  | "no_event_signal"
  /** Reached the origin, got a non-2xx. */
  | "http_error"
  /** Never reached the origin: DNS failure, TLS failure, timeout, abort. */
  | "unreachable";

export interface UrlHealthInput {
  /** False when the fetch threw or timed out — we never saw a response. */
  reachedOrigin: boolean;
  /** HTTP status, when there was one. */
  status: number | null;
  /** Response body. May be null when unreachable. */
  html: string | null;
}

export interface UrlHealthResult {
  verdict: UrlHealthVerdict;
  /** Which signals fired, so a surprising verdict is auditable without a re-fetch. */
  signals: string[];
  /** Short, storable reason. Never the whole page. */
  detail: string;
}

/**
 * Month names, long and abbreviated. A page describing a real fair says WHEN.
 *
 * Deliberately not a date-format parser: the Ledyard site would defeat one (it
 * has prose and headings and no dates at all), and a parser that handles every
 * organizer's hand-rolled format is the thing we already failed to build twice.
 * The question here is much weaker and therefore much more answerable: does
 * this page mention a month and a plausible year, anywhere?
 */
const MONTH_RE =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/** A 4-digit year in a range a fair could plausibly be scheduled in. */
const YEAR_RE = /\b20[2-4]\d\b/;

/**
 * Language an event page has and a parked/repurposed domain does not.
 *
 * Chosen from the failing specimens rather than from imagination: the Ledyard
 * replacement site is explicitly described as carrying "no dates, no hours, no
 * admission, no vendor terms", and those are exactly the four things a fair
 * page always states.
 */
const EVENT_LANGUAGE_RE =
  /\b(admission|tickets?|gate\s*price|opens?\s+at|hours?|schedule|vendors?|exhibitors?|midway|grandstand|fairgrounds?|parking|wristband|entry\s+fee)\b/i;

/** A schema.org Event in JSON-LD is the strongest possible signal. */
const JSONLD_EVENT_RE = /"@type"\s*:\s*"[^"]*Event[^"]*"/i;

/**
 * Strip markup so the text checks read prose, not attributes.
 *
 * `<script>` and `<style>` go first and entirely, contents included — otherwise
 * a date sitting in a JS string or a CSS `content:` rule counts as a signal.
 *
 * ⚠️ The `<head>` strip is about `<title>`, NOT about `<meta>`. I first wrote
 * that it was there to stop the Clinton hijack's stale 2019 meta-keywords from
 * reading as a live event signal, and a mutation test proved that wrong: the
 * generic `<[^>]+>` strip already deletes a `<meta>` element whole, attributes
 * and all, so meta content never reaches the text either way. Removing the
 * `<head>` line changed no result.
 *
 * What it genuinely defends against is a hijacked page that keeps the ORIGINAL
 * `<title>` — "Clinton Lions Ag Fair 2019" — while replacing the body. That
 * title alone carries a year and event language, i.e. the two signals needed to
 * read `ok`. Clinton's own title happened to be replaced too, so the specimen
 * does not exercise it; `keeps a stale <title> from rescuing a hijacked page`
 * in the test file does.
 */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A page too short to say anything is not evidence of health.
 *
 * Parked domains frequently serve a near-empty 200. Treating that as `ok`
 * because it "loaded fine" is the status-code mistake one level up.
 */
const MIN_MEANINGFUL_TEXT = 200;

export function classifyUrlHealth(input: UrlHealthInput): UrlHealthResult {
  if (!input.reachedOrigin) {
    return {
      verdict: "unreachable",
      signals: [],
      detail: "fetch threw or timed out before a response",
    };
  }

  const status = input.status ?? 0;
  if (status < 200 || status >= 300) {
    return { verdict: "http_error", signals: [], detail: `HTTP ${status}` };
  }

  const html = input.html ?? "";
  const signals: string[] = [];

  // JSON-LD is checked against the RAW html on purpose — it lives in a <script>
  // block, which visibleText() removes. This is the one signal that legitimately
  // comes from markup rather than prose.
  if (JSONLD_EVENT_RE.test(html)) signals.push("jsonld-event");

  const text = visibleText(html);
  if (MONTH_RE.test(text)) signals.push("month-name");
  if (YEAR_RE.test(text)) signals.push("year");
  if (EVENT_LANGUAGE_RE.test(text)) signals.push("event-language");

  if (text.length < MIN_MEANINGFUL_TEXT && signals.length === 0) {
    return {
      verdict: "no_event_signal",
      signals,
      detail: `200 but only ${text.length} chars of visible text and no event signal`,
    };
  }

  // A month name ALONE is not enough. "December" appears in a blog byline, a
  // copyright line, an author bio — all three are on the Ledyard replacement
  // site. Requiring a second, independent signal is what keeps that page out of
  // `ok`, and it is the condition worth pinning in a test.
  const strong = signals.includes("jsonld-event");
  if (strong || signals.length >= 2) {
    return { verdict: "ok", signals, detail: `event signals: ${signals.join(", ")}` };
  }

  return {
    verdict: "no_event_signal",
    signals,
    detail:
      signals.length === 0
        ? `200, ${text.length} chars of text, no event signal at all`
        : `200 but only a weak lone signal (${signals.join(", ")})`,
  };
}

/**
 * Does this verdict mean an operator should look at the URL?
 *
 * `unreachable` is deliberately NOT actionable on its own. Origins blip, and a
 * queue that fills with transient DNS failures is a queue nobody reads — which
 * is how the real finding gets buried. Persistence across checks is what makes
 * `unreachable` interesting, and persistence is a property of the stored
 * history, not of one look.
 */
export function isActionable(verdict: UrlHealthVerdict): boolean {
  return verdict === "no_event_signal" || verdict === "http_error";
}
