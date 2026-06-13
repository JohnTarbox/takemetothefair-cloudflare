export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";
import {
  fetchStandard,
  fetchViaBrowserRendering,
  shouldEscalate,
  isBlockedSsrfHost,
  FETCH_TIMEOUT,
} from "@takemetothefair/site-fetch";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

// The fetch-with-Browser-Rendering-escalation primitives (fetchStandard,
// fetchViaBrowserRendering, shouldEscalate) moved to
// @takemetothefair/site-fetch (2026-06-13) so the MCP Worker's vendor-
// enrichment dispatcher can reuse the same A5 path. Behavior here is
// unchanged — this route still drives the orchestration + logging inline.

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
