export const dynamic = "force-dynamic";
/**
 * GET /api/suggest-event/fetch?url=… — the PUBLIC "suggest an event" form's
 * "fetch this page for me" step (src/app/suggest-event/page.tsx, and the
 * vendor portal's copy). Anonymous by design, rate-limited per IP.
 *
 * OPE-1370 (SSRF4) — this was an open fetch proxy: its own inline host check
 * (missing `localhost.`, `[::7f00:1]`, `[::ffff:7f00:1]`), redirects followed
 * unchecked, and `response.text()` with no size cap. It now goes through
 * `guardedFetch`: the shared SSRF guard on EVERY redirect hop, a 3 MB body
 * cap read as a stream, and one timeout covering headers and body.
 *
 * Not behind Turnstile, deliberately: Turnstile tokens are single-use, and
 * the form's one token is spent by the submit POST (which verifies it). Making
 * fetch consume it would need a second widget solve mid-form — a UX change,
 * not a small one. What is fetched is returned as extracted text only, so with
 * the guard + cap + per-IP limit the residual is a rate-limited, size-capped
 * text proxy for public pages.
 */
import { NextRequest, NextResponse } from "next/server";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { guardedFetch, isGuardedFetchError } from "@takemetothefair/site-fetch";

const FETCH_TIMEOUT = 15000; // 15 seconds — headers AND body
/** A real event page is well under this; anything larger is not worth a public proxy. */
const SUGGEST_FETCH_MAX_BYTES = 3 * 1024 * 1024;

export async function GET(request: NextRequest) {
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "suggest-event-fetch");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();

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

  try {
    const response = await guardedFetch(parsedUrl.href, {
      maxBytes: SUGGEST_FETCH_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      response.cancel();
      if (response.status === 403) {
        return NextResponse.json(
          {
            success: false,
            error: "Could not access page (403 Forbidden). Try pasting the content manually.",
          },
          { status: 200 }
        );
      }
      if (response.status === 404) {
        return NextResponse.json(
          {
            success: false,
            error: "Page not found (404). Please check the URL.",
          },
          { status: 200 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: `Failed to fetch page (${response.status})`,
        },
        { status: 200 }
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      response.cancel();
      return NextResponse.json(
        {
          success: false,
          error: "URL does not point to an HTML page",
        },
        { status: 200 }
      );
    }

    const html = await response.text();

    // Extract metadata and text content
    const metadata = extractMetadata(html);
    const content = extractTextFromHtml(html);

    return NextResponse.json({
      success: true,
      content,
      title: metadata.title || null,
      description: metadata.description || null,
      ogImage: metadata.ogImage || null,
      jsonLd: metadata.jsonLd || null,
    });
  } catch (error) {
    if (isGuardedFetchError(error)) {
      if (error.code === "blocked_host" || error.code === "blocked_protocol") {
        // The first hop, or a redirect hop, pointed at an internal address.
        return NextResponse.json(
          { success: false, error: "Internal URLs are not allowed" },
          { status: 400 }
        );
      }
      if (error.code === "timeout") {
        return NextResponse.json(
          {
            success: false,
            error: "Page took too long to load. Try pasting the content manually.",
          },
          { status: 200 }
        );
      }
      if (error.code === "too_large") {
        return NextResponse.json(
          {
            success: false,
            error: "That page is too large to fetch. Try pasting the content manually.",
          },
          { status: 200 }
        );
      }
      // Network failures, redirect loops: the user's fix is the same. Logged
      // as before (a network failure was the route's one logged case).
      await logError(db, {
        message: "Fetch error",
        error,
        source: "api/suggest-event/fetch",
        request,
      });
      return NextResponse.json(
        {
          success: false,
          error: "Could not fetch page. Try pasting the content manually.",
        },
        { status: 200 }
      );
    }

    await logError(db, {
      message: "Fetch error",
      error,
      source: "api/suggest-event/fetch",
      request,
    });
    return NextResponse.json(
      {
        success: false,
        error: "Could not fetch page. Try pasting the content manually.",
      },
      { status: 200 }
    );
  }
}
