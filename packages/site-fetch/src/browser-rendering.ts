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
/** 25s for Browser Rendering — managed Chrome is slower. */
export const BROWSER_RENDERING_TIMEOUT = 25000;

/**
 * Real-browser UA. A self-identifying bot UA ("MeetMeAtTheFair/1.0") tripped
 * many hosting-provider WAFs; standardizing on a Chrome fingerprint keeps the
 * standard path closer to Browser Rendering's real Chrome and avoids
 * unnecessary escalations.
 */
export const FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
  return { ok: true, html: await response.text(), finalUrl: response.url || url };
}

/**
 * Browser-Rendering escalation. When standard fetch hits a WAF that blocks
 * Worker-shape requests, Cloudflare's managed headless Chrome fetches the URL
 * with a real browser fingerprint (TLS handshake, Accept headers, JS exec).
 * Calls the REST `/content` endpoint (not the Workers Puppeteer binding) —
 * minimum billable browser time, no held-open sessions.
 */
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
      body: JSON.stringify({ url }),
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
    return {
      ok: false,
      status: response.status,
      error: `browser-rendering-http-${response.status}`,
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
  return { ok: true, html: body.result };
}

/**
 * Should a failed standard-fetch outcome escalate to Browser Rendering?
 * 401/403/429 are the classic WAF bot-block signatures; timeouts + network
 * errors sometimes recover when proxied through CF's edge. 404s, non-HTML
 * content-types, and PDFs are NOT escalated (no point — BR can't recover them).
 */
export function shouldEscalate(outcome: FetchOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.error === "timeout") return true;
  if (outcome.error === "content-type") return false;
  if (outcome.error === "pdf-unsupported") return false;
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
