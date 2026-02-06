import { NextRequest, NextResponse } from "next/server";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const FETCH_TIMEOUT = 15000; // 15 seconds

export async function GET(request: NextRequest) {
  const db = getCloudflareDb();

  const url = request.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json(
      { success: false, error: "URL is required" },
      { status: 400 }
    );
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
      a === 127 ||                          // 127.0.0.0/8
      a === 10 ||                           // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
      (a === 192 && b === 168) ||           // 192.168.0.0/16
      (a === 169 && b === 254) ||           // 169.254.0.0/16
      a === 0                               // 0.0.0.0/8
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
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(parsedUrl.href, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
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
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        {
          success: false,
          error: "Page took too long to load. Try pasting the content manually.",
        },
        { status: 200 }
      );
    }

    await logError(db, { message: "Fetch error", error, source: "api/suggest-event/fetch", request });
    return NextResponse.json(
      {
        success: false,
        error: "Could not fetch page. Try pasting the content manually.",
      },
      { status: 200 }
    );
  }
}
