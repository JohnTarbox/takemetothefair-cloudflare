/**
 * Site-fetch with Browser-Rendering escalation — the A5 fetch path, promoted
 * to a shared package (2026-06-13, I1 vendor-enrichment Worker).
 *
 * Originally lived inline in src/app/api/admin/import-url/fetch/route.ts. Now
 * two callers need it: the main app's import-url route AND the MCP Worker's
 * vendor-enrichment dispatcher. Both run on Cloudflare (Workers / next-on-
 * pages edge), so the only runtime dependency is the global `fetch` +
 * `AbortController` — no Node APIs. Env is passed in, never read from a
 * global, so the module stays testable and binding-agnostic.
 *
 * NOTE: this is the one I/O-bearing shared module — kept OUT of
 * @takemetothefair/utils, which is contractually pure/no-side-effect.
 */

/** 15s for the standard fetch path. */
export const FETCH_TIMEOUT = 15000;
import { isBlockedSsrfHost } from "./ssrf-guard";
import { detectChallengePage, CHALLENGE_USER_MESSAGE } from "./challenge-page";

/** 25s for Browser Rendering — managed Chrome is slower. */
export const BROWSER_RENDERING_TIMEOUT = 25000;

/**
 * Page-load options for the Browser Rendering `/content` call.
 *
 * We passed NOTHING here until 2026-08-24, taking whatever the API defaulted
 * to. Cloudflare's FAQ on `422 Unprocessable Entity` says it "usually means
 * Browser Run was not able to complete an action because of an issue with the
 * site… Most often, this error is caused by a timeout", and every worked
 * example in their docs passes explicit `gotoOptions`. Ours 422'd on every
 * attempt from 2026-07-19 onward while the request body had not changed since
 * PR #478 — i.e. the regression was on their side, and the documented remedy
 * is to stop relying on the default.
 *
 * ⚠️ `timeout` MUST stay below BROWSER_RENDERING_TIMEOUT (our own abort). If
 * ours fires first we kill the request before the API can tell us why it
 * failed, which is the exact blindness this change exists to remove. 20s
 * leaves 5s of headroom for the API to answer.
 *
 * `networkidle2` (≤2 in-flight connections for 500ms) rather than
 * `domcontentloaded`: the pages that reach this path are the ones that render
 * their content with JavaScript, so returning at DOMContentLoaded would hand
 * back the same empty shell the standard fetch already got.
 */
/** Cap on captured upstream error text — it lands in a D1 log column. */
export const API_ERROR_DETAIL_CAP = 300;

export const BROWSER_RENDERING_GOTO = {
  waitUntil: "networkidle2",
  timeout: 20000,
} as const;

/**
 * Real-browser UA. A self-identifying bot UA ("MeetMeAtTheFair/1.0") tripped
 * many hosting-provider WAFs; standardizing on a Chrome fingerprint keeps the
 * standard path closer to Browser Rendering's real Chrome and avoids
 * unnecessary escalations.
 *
 * ⚠️ THE VERSION NUMBER IS LOAD-BEARING AND IT ROTS. Keep it current.
 *
 * OPE-537: this said `Chrome/120.0.0.0`, set 2026-06-12 (`e502627d`). Chrome
 * 120 shipped in December 2023 — it was ~18 months stale the day it was
 * committed and ~2.7 years stale when it was found. WAF fake-browser
 * heuristics treat a UA claiming a Chrome version no real Chrome has run for
 * years as forged, and refuse it. Measured against
 * vermontartscouncil.org, three trials each:
 *
 *     Chrome/120  403 403 403      Chrome/131  403 403 403
 *     Chrome/124  403 403 403      Chrome/141  200 200 200
 *
 * It is not bot-vs-browser and it is not the platform token — Mac/120 is also
 * 403 and Windows/141 is also 200. It is the version, and the effect is not
 * one site: bumping it took ctcraftfairconnection.com (13 events) and
 * castleberryfairs.com (10 events) from 403 to 200 as well.
 *
 * The cost of it being stale is worse than a failed fetch, which is why this
 * comment is long. A 403 here does not surface as an error: the inbound
 * workflow falls through to OPE-185's body-prose fallback, and for a
 * URL-only email that means an event FABRICATED from the URL string, stored
 * with a confident wrong description and logged as a success.
 *
 * ── Last verified against a live WAF: 2026-08-24 (Chrome/147 → HTTP 200 on
 *    vermontartscouncil.org, ctcraftfairconnection.com, castleberryfairs.com).
 *    Re-verify if fetches start returning 403 for no other reason. ──
 */
export const FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export type FetchOutcome =
  // `finalUrl` is the post-redirect response URL on the standard path (used by
  // the vendor-enrichment Worker to detect malware/off-site redirects). It is
  // undefined on the Browser-Rendering path, which doesn't expose redirects.
  | { ok: true; html: string; finalUrl?: string }
  | { ok: false; status: number | null; error: string; userMessage: string };

export interface BrowserRenderingEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
}

/** Standard `fetch`. Caller supplies the abort signal (timeout is theirs). */
export async function fetchStandard(url: string, signal: AbortSignal): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      headers: {
        "User-Agent": FETCH_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        status: null,
        error: "timeout",
        userMessage: "Page took too long to load. Try pasting the content manually.",
      };
    }
    return {
      ok: false,
      status: null,
      error: `network: ${err instanceof Error ? err.message : String(err)}`,
      userMessage: "Could not fetch page. Try pasting the content manually.",
    };
  }
  if (!response.ok) {
    let userMessage: string;
    if (response.status === 403) {
      userMessage = "Could not access page (403 Forbidden). Try pasting the content manually.";
    } else if (response.status === 404) {
      userMessage = "Page not found (404). Please check the URL.";
    } else {
      userMessage = `Failed to fetch page (${response.status})`;
    }
    return { ok: false, status: response.status, error: `http-${response.status}`, userMessage };
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    // PDF gets its own code — the most common email-submission failure mode
    // (town-rec application PDFs, program PDFs). The import-url workflow uses
    // it to fire a tailored reply. Detect by Content-Type OR .pdf extension
    // (some servers return application/octet-stream for PDFs).
    const isPdfContentType = contentType.includes("application/pdf");
    const isPdfExtension = /\.pdf(?:$|[?#])/i.test(url);
    if (isPdfContentType || isPdfExtension) {
      return {
        ok: false,
        status: response.status,
        error: "pdf-unsupported",
        userMessage:
          "This URL points to a PDF. We can't parse PDFs yet — please reply with the event details pasted as text (dates, venue, hours, fees), or send the linked event page if one exists.",
      };
    }
    return {
      ok: false,
      status: response.status,
      error: "content-type",
      userMessage: "URL does not point to an HTML page",
    };
  }
  const html = await response.text();
  // A 200 is not proof we got the page we asked for. Some origins answer a
  // bot check with 200 + interstitial rather than 403, and everything
  // downstream would then extract an event from the challenge page.
  const challenge = detectChallengePage(html, response.headers);
  if (challenge.isChallenge) {
    return {
      ok: false,
      status: response.status,
      error: `challenge-page:${challenge.vendor}`,
      userMessage: CHALLENGE_USER_MESSAGE,
    };
  }
  return { ok: true, html, finalUrl: response.url || url };
}

/**
 * Browser-Rendering escalation. When standard fetch hits a WAF that blocks
 * Worker-shape requests, Cloudflare's managed headless Chrome fetches the URL
 * with a real browser fingerprint (TLS handshake, Accept headers, JS exec).
 * Calls the REST `/content` endpoint (not the Workers Puppeteer binding) —
 * minimum billable browser time, no held-open sessions.
 */
/**
 * Best-effort extraction of a human-readable reason from a failed Cloudflare
 * API response. Never throws and never rejects: this runs on a path that is
 * ALREADY failing, so a parse problem here must not replace a real upstream
 * error with a parse error.
 *
 * Cloudflare returns `{ success, errors: [{ code, message }] }`; some edge
 * failures return plain text or HTML instead, so the raw body is the fallback.
 * Capped because it lands in a D1 log column, and an HTML error page is large.
 */
async function readApiErrorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as {
      errors?: Array<{ code?: number; message?: string }>;
    };
    const named = parsed.errors
      ?.map((e) => (e.code ? `${e.code} ${e.message ?? ""}`.trim() : (e.message ?? "")))
      .filter(Boolean)
      .join("; ");
    if (named) return named.slice(0, API_ERROR_DETAIL_CAP);
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, API_ERROR_DETAIL_CAP);
}

export async function fetchViaBrowserRendering(
  url: string,
  env: BrowserRenderingEnv
): Promise<FetchOutcome> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_BROWSER_RENDERING_TOKEN) {
    return {
      ok: false,
      status: null,
      error: "browser-rendering-unconfigured",
      userMessage: "Could not fetch page. Try pasting the content manually.",
    };
  }
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/content`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BROWSER_RENDERING_TIMEOUT);
  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_BROWSER_RENDERING_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, gotoOptions: BROWSER_RENDERING_GOTO }),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        status: null,
        error: "browser-rendering-timeout",
        userMessage: "Page took too long to load. Try pasting the content manually.",
      };
    }
    return {
      ok: false,
      status: null,
      error: `browser-rendering-network: ${err instanceof Error ? err.message : String(err)}`,
      userMessage: "Could not fetch page. Try pasting the content manually.",
    };
  }
  clearTimeout(timeoutId);
  if (!response.ok) {
    // Read the body before discarding the response. This block used to throw
    // it away and keep only the status, which is why "browser-rendering-http-422"
    // was every 422 we had on record for five weeks: the status says an action
    // failed, the body says which one and why. Same lesson as the discarded
    // `extract-` upstream error (PR #1017) — a status code is not a diagnosis.
    const detail = await readApiErrorDetail(response);
    return {
      ok: false,
      status: response.status,
      // Prefix preserved so existing log greps and dashboards keep matching;
      // the detail is appended, not substituted.
      error: `browser-rendering-http-${response.status}${detail ? `: ${detail}` : ""}`,
      userMessage: "Could not fetch page. Try pasting the content manually.",
    };
  }
  // /content returns rendered HTML in `result`, wrapped in the standard
  // Cloudflare API envelope { success, result, errors }.
  type BrEnvelope = {
    success: boolean;
    result?: string;
    errors?: Array<{ message: string }>;
  };
  const body = (await response.json().catch(() => null)) as BrEnvelope | null;
  if (!body || !body.success || typeof body.result !== "string") {
    return {
      ok: false,
      status: response.status,
      error: `browser-rendering-envelope: ${body?.errors?.[0]?.message ?? "no-body"}`,
      userMessage: "Could not fetch page. Try pasting the content manually.",
    };
  }
  // BR renders whatever the origin served, including an interstitial, and
  // reports it as a successful render. This is the call site that produced
  // an event named "Just a moment..." — no origin headers are available
  // here, so the body markers are the only signal.
  const brChallenge = detectChallengePage(body.result);
  if (brChallenge.isChallenge) {
    return {
      ok: false,
      status: response.status,
      error: `browser-rendering-challenge-page:${brChallenge.vendor}`,
      userMessage: CHALLENGE_USER_MESSAGE,
    };
  }
  return { ok: true, html: body.result };
}

/**
 * Should a failed standard-fetch outcome escalate to Browser Rendering?
 * 401/403/429 are the classic WAF bot-block signatures; timeouts + network
 * errors sometimes recover when proxied through CF's edge. 404s, non-HTML
 * content-types, and PDFs are NOT escalated (no point — BR can't recover them).
 */
/**
 * OPE-537 — a 200 that carries no extractable text is a FAILED fetch.
 *
 * `shouldEscalate` above judges the HTTP status and nothing else, so a page
 * that answers 200 with a body we cannot read from — a JS-only shell, a WAF
 * interstitial, a datacenter-IP variant — was treated as a success and its
 * empty string handed downstream.
 *
 * That is exactly what happened after the UA fix landed: the Vermont Crafters
 * Expo URL stopped 403ing, `/api/admin/import-url/fetch` returned
 * `success: true`, and `inbound_emails` recorded
 *
 *     content_length_chars    0
 *     content_sha256_first16  e3b0c44298fc1c14     <- sha256 of ""
 *
 * `/api/admin/import-url/extract` then rejected it with a 400 ("Content is
 * required"), several services away from the thing that was actually wrong.
 * Browser Rendering — which exists precisely for a page whose text is not in
 * the served HTML — was never tried, because the status was 200.
 *
 * The threshold is deliberately near-zero rather than a prose-quality bar.
 * "This page has essentially no text" is a different and much safer judgement
 * than "this page has too little text to be worth extracting": a real event
 * page can legitimately be terse, and escalating those to Browser Rendering
 * would cost latency and quota for no gain. 32 characters is below any real
 * page and above the whitespace-and-nav residue an empty shell leaves.
 */
export const MIN_EXTRACTABLE_TEXT_CHARS = 32;

/** True when extracted page text is too empty to have come from a real page. */
export function isEmptyExtraction(text: string | null | undefined): boolean {
  return (text ?? "").trim().length < MIN_EXTRACTABLE_TEXT_CHARS;
}

export function shouldEscalate(outcome: FetchOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.error === "timeout") return true;
  if (outcome.error === "content-type") return false;
  if (outcome.error === "pdf-unsupported") return false;
  // A challenge is exactly what Browser Rendering exists for — a real browser
  // with a real TLS fingerprint. It does not always pass (10times.com served
  // the interstitial to BR too), but it is the one remaining option, and not
  // trying would leave escalation unattempted on the case it was built for.
  // `challenge-page:*` carries a vendor suffix, hence startsWith.
  if (outcome.error.startsWith("challenge-page:")) return true;
  if (outcome.status === null) return true; // network error
  return outcome.status === 401 || outcome.status === 403 || outcome.status === 429;
}

export interface EscalatingFetchResult {
  /** Final HTML on success, else null. */
  html: string | null;
  /** Which path produced the HTML (or attempted last). */
  fetchMethod: "standard" | "browser-rendering" | "failed";
  /** Post-redirect URL from the standard path, when available. */
  finalUrl?: string;
  /** The standard-path outcome (always present). */
  standard: FetchOutcome;
  /** The BR-path outcome, present only when escalation was attempted. */
  escalated?: FetchOutcome;
}

/**
 * Full standard → escalate orchestration with the standard-path timeout
 * managed internally. Callers get back enough detail to log both failure
 * codes on a double-miss without re-implementing the control flow.
 */
export async function fetchWithEscalation(
  url: string,
  env: BrowserRenderingEnv
): Promise<EscalatingFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  let standard: FetchOutcome;
  try {
    standard = await fetchStandard(url, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }

  if (standard.ok) {
    return { html: standard.html, fetchMethod: "standard", finalUrl: standard.finalUrl, standard };
  }
  if (!shouldEscalate(standard)) {
    return { html: null, fetchMethod: "failed", standard };
  }
  const escalated = await fetchViaBrowserRendering(url, env);
  if (escalated.ok) {
    return { html: escalated.html, fetchMethod: "browser-rendering", standard, escalated };
  }
  return { html: null, fetchMethod: "failed", standard, escalated };
}

/**
 * SSRF-guarded HTML fetch for a URL supplied by an UNTRUSTED party.
 *
 * `fetchStandard` deliberately does not guard: its callers pass URLs an
 * operator typed or that came from our own data. When the URL originates from
 * a public, unverified user — a vendor's self-declared website at registration
 * (OPE-237) — a single up-front host check is not enough either, because a
 * public host can 3xx-redirect to an internal address.
 *
 * So redirects are followed MANUALLY and the check re-runs on every hop, which
 * is the pattern `/api/admin/upload-image-from-url` and
 * `/api/admin/import-url/fetch` already established here.
 *
 * ⚠️ Documented residual, same as those two: **DNS rebinding is not covered.**
 * `isBlockedSsrfHost` is a string check, and the Workers runtime exposes no
 * resolved IP to validate against, so a public hostname whose A-record points
 * at a private address still resolves. Accepted for the same reason: Workers
 * have no metadata service and no internal HTTP network to pivot into. Do not
 * read this helper as making an arbitrary URL safe to fetch in a runtime that
 * DOES have those.
 */
export async function fetchHtmlWithSsrfGuard(
  rawUrl: string,
  signal: AbortSignal,
  maxRedirects = 3
): Promise<FetchOutcome> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, status: null, error: "invalid_url", userMessage: "Not a valid URL." };
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return {
        ok: false,
        status: null,
        error: "blocked_protocol",
        userMessage: "Only http(s) URLs are supported.",
      };
    }
    if (isBlockedSsrfHost(current.hostname)) {
      return {
        ok: false,
        status: null,
        error: "blocked_host",
        userMessage: "Internal URLs are not allowed.",
      };
    }

    let resp: Response;
    try {
      resp = await fetch(current.href, {
        signal,
        redirect: "manual",
        headers: {
          "User-Agent": FETCH_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, status: null, error: "timeout", userMessage: "Page took too long." };
      }
      return {
        ok: false,
        status: null,
        error: `network: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: "Could not fetch page.",
      };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) {
        return {
          ok: false,
          status: resp.status,
          error: "redirect_without_location",
          userMessage: "Could not fetch page.",
        };
      }
      try {
        current = new URL(loc, current);
      } catch {
        return {
          ok: false,
          status: resp.status,
          error: "invalid_redirect",
          userMessage: "Could not fetch page.",
        };
      }
      continue; // re-check the new hop at the top of the loop
    }

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: `http_${resp.status}`,
        userMessage: `Page returned ${resp.status}.`,
      };
    }
    return { ok: true, html: await resp.text(), finalUrl: current.href };
  }

  return {
    ok: false,
    status: null,
    error: "too_many_redirects",
    userMessage: "Too many redirects.",
  };
}
