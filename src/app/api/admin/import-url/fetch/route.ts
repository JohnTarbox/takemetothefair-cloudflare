export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

const FETCH_TIMEOUT = 15000; // 15 seconds for the standard fetch path
const BROWSER_RENDERING_TIMEOUT = 25000; // 25 seconds — managed Chrome is slower

// Real-browser UA. The previous self-identifying bot UA
// ("MeetMeAtTheFair/1.0") tripped many hosting-provider WAFs. Browser
// Rendering uses a real Chrome anyway; standardizing here keeps the
// standard path closer to that fingerprint and avoids unnecessary
// escalations.
const FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type FetchOutcome =
  | { ok: true; html: string }
  | { ok: false; status: number | null; error: string; userMessage: string };

async function fetchStandard(url: string, signal: AbortSignal): Promise<FetchOutcome> {
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
    // PDF gets its own code because it's the most common email-submission
    // failure mode the analyst flagged (C2, 2026-05-29) — town-rec
    // application PDFs, program PDFs, etc. The workflow uses this code
    // to fire a tailored reply ("we can't parse PDFs yet, paste the
    // event details") instead of the generic "URL doesn't work" reply.
    // Detect either by Content-Type or by .pdf URL extension; the latter
    // catches servers that return application/octet-stream for PDFs.
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
  return { ok: true, html: await response.text() };
}

interface BrowserRenderingEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
}

// Escalation path: when standard fetch hits a WAF that blocks Worker-shape
// requests, Cloudflare Browser Rendering's managed headless Chrome fetches
// the URL with a real browser fingerprint (TLS handshake, Accept headers,
// JS execution). Most hosting-provider WAFs accept that traffic where they
// reject raw fetch even with a browser UA. Calls the REST `/content`
// endpoint (not the Workers Puppeteer binding) — minimum billable browser
// time, no held-open sessions.
async function fetchViaBrowserRendering(
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
  // /content returns the rendered HTML in `result`, wrapped in the standard
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

// Status codes that should trigger Browser Rendering escalation. 401/403/429
// are the classic WAF bot-block signatures. Timeouts also escalate — slow
// origin sometimes recovers when proxied through CF's edge. 404s and
// non-HTML content-types are NOT escalated (no point — page truly doesn't
// exist or isn't fetchable as HTML).
function shouldEscalate(outcome: FetchOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.error === "timeout") return true;
  if (outcome.error === "content-type") return false;
  // PDF detected — Browser Rendering /content returns HTML, not the
  // text-extracted PDF body, so escalation can't recover this. Surface
  // the dedicated reply instead.
  if (outcome.error === "pdf-unsupported") return false;
  if (outcome.status === null) return true; // network error
  return outcome.status === 401 || outcome.status === 403 || outcome.status === 429;
}

export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  // Accept admin session OR X-Internal-Key (MCP Worker calls this from the
  // inbound-email handler to fetch URLs sent to submit@meetmeatthefair.com).
  const internalKey = request.headers.get("x-internal-key");
  const cfEnv = getCloudflareEnv() as unknown as {
    INTERNAL_API_KEY?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  };
  const isInternal = !!(
    internalKey &&
    cfEnv.INTERNAL_API_KEY &&
    internalKey === cfEnv.INTERNAL_API_KEY
  );
  if (!isInternal) {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

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

  // SSRF protection: block internal/private hostnames and IPs
  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return NextResponse.json(
      { success: false, error: "Internal URLs are not allowed" },
      { status: 400 }
    );
  }

  // Block private/reserved IP ranges
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (
      a === 127 || // 127.0.0.0/8
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // 169.254.0.0/16
      a === 0 // 0.0.0.0/8
    ) {
      return NextResponse.json(
        { success: false, error: "Internal URLs are not allowed" },
        { status: 400 }
      );
    }
  }

  // Block IPv6 private ranges
  if (hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe80")) {
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
    const metadata = extractMetadata(html);
    const content = extractTextFromHtml(html);

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
}
