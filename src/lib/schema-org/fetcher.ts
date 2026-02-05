import { extractMetadata } from "@/lib/url-import/html-parser";
import { parseJsonLd } from "./parser";
import type { FetchSchemaOrgResult, SchemaOrgStatus } from "./types";

const FETCH_TIMEOUT = 15000; // 15 seconds

/**
 * SSRF protection: block internal/private hostnames and IPs
 * Pattern from /api/admin/import-url/fetch/route.ts
 */
function isInternalUrl(urlString: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return true;
    }
  } catch {
    return true;
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // Block internal hostnames
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
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
      return true;
    }
  }

  // Block IPv6 private ranges
  if (hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe80")) {
    return true;
  }

  return false;
}

/**
 * Fetch a URL and extract schema.org Event JSON-LD
 */
export async function fetchSchemaOrg(url: string): Promise<FetchSchemaOrgResult> {
  // Validate URL
  if (!url || typeof url !== "string") {
    return {
      success: false,
      data: null,
      rawJsonLd: null,
      status: "error",
      error: "URL is required",
    };
  }

  // SSRF protection
  if (isInternalUrl(url)) {
    return {
      success: false,
      data: null,
      rawJsonLd: null,
      status: "error",
      error: "Internal URLs are not allowed",
    };
  }

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
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
      return {
        success: false,
        data: null,
        rawJsonLd: null,
        status: "error",
        error: `Failed to fetch page (${response.status})`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return {
        success: false,
        data: null,
        rawJsonLd: null,
        status: "error",
        error: "URL does not point to an HTML page",
      };
    }

    const html = await response.text();

    // Extract metadata including JSON-LD
    const metadata = extractMetadata(html);

    if (!metadata.jsonLd) {
      return {
        success: false,
        data: null,
        rawJsonLd: null,
        status: "not_found",
        error: "No schema.org Event markup found on page",
      };
    }

    // Parse the JSON-LD
    const parseResult = parseJsonLd(metadata.jsonLd);

    return {
      success: parseResult.success,
      data: parseResult.data,
      rawJsonLd: parseResult.rawJsonLd,
      status: parseResult.status as SchemaOrgStatus,
      error: parseResult.error,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        success: false,
        data: null,
        rawJsonLd: null,
        status: "error",
        error: "Page took too long to load",
      };
    }

    return {
      success: false,
      data: null,
      rawJsonLd: null,
      status: "error",
      error: error instanceof Error ? error.message : "Failed to fetch page",
    };
  }
}

/**
 * Create an index file to re-export everything
 */
export { parseJsonLd } from "./parser";
export * from "./types";
