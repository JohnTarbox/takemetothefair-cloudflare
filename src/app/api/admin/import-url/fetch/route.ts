export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";
import {
  fetchStandard,
  fetchViaBrowserRendering,
  shouldEscalate,
  isBlockedSsrfHost,
  FETCH_TIMEOUT,
  isEmptyExtraction,
  detectChallengePage,
  CHALLENGE_USER_MESSAGE,
} from "@takemetothefair/site-fetch";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

// The fetch-with-Browser-Rendering-escalation primitives (fetchStandard,
// fetchViaBrowserRendering, shouldEscalate) moved to
// @takemetothefair/site-fetch (2026-06-13) so the MCP Worker's vendor-
// enrichment dispatcher can reuse the same A5 path. Behavior here is
// unchanged — this route still drives the orchestration + logging inline.

// Dual auth (admin session OR X-Internal-Key) via withAuthorized — the MCP
// Worker calls this from the inbound-email handler to fetch URLs sent to
// submit@meetmeatthefair.com. allowReadonlyBearer:false because this GET has a
// real side effect (it triggers an outbound fetch + Browser Rendering), so the
// read-only Claude token must NOT authorize it — only an admin session or the
// internal key. Replaces the prior inline timing-unsafe `===` key check.
/**
 * A short, single-line, size-capped sample of a response body for the error log.
 *
 * Whitespace is collapsed because minified and pretty-printed markup differ by
 * hundreds of leading spaces, which would push the informative part of a stub
 * page past the cap. The cap keeps a full HTML error page out of a D1 column.
 */
const HTML_LOG_PREFIX_CHARS = 220;
function htmlLogPrefix(html: string): string {
  return html.replace(/\s+/g, " ").trim().slice(0, HTML_LOG_PREFIX_CHARS);
}

export const GET = withAuthorized({ allowReadonlyBearer: false }, async ({ request, db }) => {
  // Browser-Rendering credentials for the escalation path below.
  const cfEnv = getCloudflareEnv() as unknown as {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  };

  const url = request.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json({ success: false, error: "URL is required" }, { status: 400 });
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return NextResponse.json(
      { success: false, error: "Please enter a valid URL" },
      { status: 400 }
    );
  }

  // SSRF protection (WS3c, 2026-06-11) — block internal/private hosts. The
  // shared, unit-tested guard closes the encoded-IP bypasses the old inline
  // check missed (decimal/hex/octal integer IPs, IPv4-mapped & expanded IPv6).
  // DNS-rebinding (public name → internal IP) remains a documented residual —
  // see @takemetothefair/site-fetch ssrf-guard. Defense-in-depth on an
  // admin-only route on Cloudflare Workers (no metadata service / internal
  // HTTP network).
  if (isBlockedSsrfHost(parsedUrl.hostname)) {
    return NextResponse.json(
      { success: false, error: "Internal URLs are not allowed" },
      { status: 400 }
    );
  }

  try {
    // Standard fetch first (cheap, fast — works for the ~70–85% of sites
    // that don't WAF-block real-browser UAs).
    const standardController = new AbortController();
    const standardTimeoutId = setTimeout(() => standardController.abort(), FETCH_TIMEOUT);
    const standard = await fetchStandard(parsedUrl.href, standardController.signal);
    clearTimeout(standardTimeoutId);

    let html: string;
    let fetchMethod: "standard" | "browser-rendering";

    if (standard.ok) {
      html = standard.html;
      fetchMethod = "standard";
    } else if (shouldEscalate(standard)) {
      // Escalate to Browser Rendering. Logs the upstream signal so post-deploy
      // analytics can show which standard-fetch failure modes are recovered.
      const escalated = await fetchViaBrowserRendering(parsedUrl.href, cfEnv);
      if (escalated.ok) {
        html = escalated.html;
        fetchMethod = "browser-rendering";
      } else {
        await logError(db, {
          level: "warn",
          message: `Fetch failed both paths: standard=${standard.error} br=${escalated.error}`,
          source: "api/admin/import-url/fetch",
          context: {
            url: parsedUrl.href,
            standardStatus: standard.status,
            brStatus: escalated.status,
          },
        });
        return NextResponse.json(
          { success: false, error: standard.userMessage, fetchMethod: "failed" },
          { status: 200 }
        );
      }
    } else {
      // No escalation (404, non-HTML content-type, etc.) — surface
      // standard-fetch user message as-is. PDF gets its own fetchMethod
      // value so /admin/inbound-emails (and the analyst's fetch_method
      // analytics card) can distinguish "we got a PDF" from generic
      // failures, and the workflow can route to the tailored reply.
      const fetchMethod = standard.error === "pdf-unsupported" ? "pdf_unsupported" : "failed";
      return NextResponse.json(
        { success: false, error: standard.userMessage, fetchMethod },
        { status: 200 }
      );
    }

    // Extract metadata and text content (reused from html-parser.ts —
    // works identically on HTML from either fetch path).
    let metadata = extractMetadata(html);
    let content = extractTextFromHtml(html);

    // OPE-537 — a 200 carrying no extractable text is a FAILED fetch.
    //
    // `shouldEscalate` judges the HTTP status alone, so a page answering 200
    // with an unreadable body (JS-only shell, WAF interstitial, datacenter-IP
    // variant) reached here, got extracted to "", and was returned as
    // `success: true`. Downstream, `/api/admin/import-url/extract` rejected
    // the empty string with a 400 — several services away from the actual
    // problem, and with the real reason discarded in between.
    //
    // Measured on the 2026-08-24 re-submit of the Vermont Crafters Expo URL,
    // AFTER the UA fix removed the 403: `content_length_chars = 0`,
    // `content_sha256_first16 = e3b0c44298fc1c14` (sha256 of ""). Browser
    // Rendering — which exists for exactly this page shape — was never tried,
    // because the status was 200.
    //
    // So emptiness now escalates the same way a 403 does, and if the rendered
    // path is also empty we say so plainly instead of passing "" off as a
    // fetched page. Only attempted once: if we already came from Browser
    // Rendering there is nothing further to escalate to.
    // OPE-537 item 3 — a bot-check interstitial is a FETCH FAILURE, not a page.
    //
    // `isEmptyExtraction` catches the shell that yields no text. It cannot
    // catch the other half of the same problem: a challenge page yields text
    // that is real, extractable and about nothing, so it clears the 32-char
    // floor and is handed downstream as the page we asked for. That is how
    // `1da06d90` became an event named "Just a moment...", slug
    // `just-a-moment`, with the submitter told `ok-low`.
    //
    // `detectChallengePage` already existed in @takemetothefair/site-fetch,
    // fully implemented and tested — and NOTHING called it. Wiring it rather
    // than writing a second detector: a duplicate would drift from the vendor
    // marker list, and that list is the part that has to stay current.
    //
    // ⚠️ Headers are NOT passed, and that is a real limitation rather than an
    // oversight: `FetchOutcome` does not carry them, so Cloudflare's
    // `cf-mitigated: challenge` header — the strongest and cheapest signal the
    // detector supports — is unavailable at this call site. Body markers alone
    // cover the reported specimen. Plumbing headers through `FetchOutcome`
    // would strengthen this and is deliberately left out of scope here.
    const challenge = detectChallengePage(html, null);

    if (isEmptyExtraction(content) || challenge.isChallenge) {
      const alreadyRendered = fetchMethod === "browser-rendering";
      const rendered = alreadyRendered
        ? null
        : await fetchViaBrowserRendering(parsedUrl.href, cfEnv);
      // The rendered page must clear BOTH bars. Browser Rendering follows the
      // challenge like any browser would, so it can return a second
      // interstitial that is merely longer; accepting it on the emptiness test
      // alone would re-open the hole one hop further along. No headers are
      // available on that path, which is why the body markers carry it.
      const renderedText = rendered?.ok ? extractTextFromHtml(rendered.html) : "";
      const renderedChallenge = rendered?.ok
        ? detectChallengePage(rendered.html, null)
        : { isChallenge: false, vendor: null, signal: null };

      if (rendered?.ok && !isEmptyExtraction(renderedText) && !renderedChallenge.isChallenge) {
        html = rendered.html;
        metadata = extractMetadata(html);
        content = extractTextFromHtml(html);
        fetchMethod = "browser-rendering";
      } else {
        await logError(db, {
          level: "warn",
          message:
            (challenge.isChallenge
              ? `Fetch returned a ${challenge.vendor} bot-check interstitial, not the page: ${fetchMethod}`
              : `Fetch returned 200 with no extractable text: ${fetchMethod}`) +
            (alreadyRendered
              ? " (already rendered)"
              : ` br=${rendered?.ok ? "empty" : rendered?.error}`),
          source: "api/admin/import-url/fetch",
          context: {
            url: parsedUrl.href,
            htmlBytes: html.length,
            extractedChars: content.trim().length,
            firstFetchMethod: fetchMethod,
            brError: rendered?.ok ? "rendered-but-empty" : (rendered?.error ?? "not-attempted"),
            // What the body ACTUALLY was. We logged htmlBytes and threw the
            // bytes away, so "200 with 219 bytes" was as far as any diagnosis
            // could get — a WAF stub, a meta-refresh, a JS challenge and an
            // empty CMS shell are indistinguishable by length. A prefix
            // separates them on the first occurrence instead of the second.
            htmlPrefix: htmlLogPrefix(html),
            // OPE-537 — which vendor's interstitial, so the log distinguishes
            // "this origin blocks us" from "this page has no text".
            challengeVendor: challenge.vendor,
            challengeSignal: challenge.signal,
            // Present only when Browser Rendering DID return a page that we
            // then failed to extract text from — that is a different bug from
            // the origin refusing us, and it needs its own sample.
            ...(rendered?.ok ? { renderedPrefix: htmlLogPrefix(rendered.html) } : {}),
          },
        });
        // Reported as a failure, with a message that names THIS cause rather
        // than letting a downstream validator invent a different one.
        return NextResponse.json(
          {
            success: false,
            // The challenge case gets its own copy: the URL loads perfectly in
            // the submitter's own browser, so "no readable text" reads as us
            // being broken and invites them to re-send the same link.
            error: challenge.isChallenge
              ? CHALLENGE_USER_MESSAGE
              : "Fetched the page but found no readable text on it. It may require JavaScript or be blocking automated access. Try pasting the content manually.",
            fetchMethod: "failed",
          },
          { status: 200 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      content,
      title: metadata.title || null,
      description: metadata.description || null,
      ogImage: metadata.ogImage || null,
      jsonLd: metadata.jsonLd || null,
      // Multi-event JSON-LD passthrough (analyst P7a). Older callers that
      // only consume `jsonLd` keep working; new ones can map the whole
      // array through the extract endpoint to produce N events from one
      // landing page.
      jsonLdEvents: metadata.jsonLdEvents || null,
      fetchMethod,
    });
  } catch (error) {
    await logError(db, {
      message: "Fetch route unexpected error",
      error,
      source: "api/admin/import-url/fetch",
      request,
    });
    return NextResponse.json(
      {
        success: false,
        error: "Could not fetch page. Try pasting the content manually.",
        fetchMethod: "failed",
      },
      { status: 200 }
    );
  }
});
