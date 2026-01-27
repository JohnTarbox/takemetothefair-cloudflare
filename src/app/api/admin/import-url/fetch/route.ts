import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";

export const runtime = "edge";

const FETCH_TIMEOUT = 15000; // 15 seconds

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

    console.error("Fetch error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Could not fetch page. Try pasting the content manually.",
      },
      { status: 200 }
    );
  }
}
