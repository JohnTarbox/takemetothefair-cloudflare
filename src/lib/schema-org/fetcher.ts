import { extractMetadata } from "@/lib/url-import/html-parser";
import { parseJsonLd } from "./parser";
import type { FetchSchemaOrgResult, SchemaOrgStatus } from "./types";
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";
import {
  guardedFetch,
  isGuardedFetchError,
  GUARDED_HTML_MAX_BYTES,
} from "@takemetothefair/site-fetch";

const FETCH_TIMEOUT = 15000; // 15 seconds — headers AND body

function failure(error: string): FetchSchemaOrgResult {
  return { success: false, data: null, rawJsonLd: null, status: "error", error };
}

/**
 * Fetch a URL and extract schema.org Event JSON-LD
 *
 * OPE-1370 (SSRF6) — this had a third, ad-hoc host validator (it missed
 * `localhost.`, `[::7f00:1]` and every encoded-IPv4 form), checked the first
 * hop only, and read the body uncapped. It now uses `guardedFetch`: the shared
 * guard on every redirect hop and a GUARDED_HTML_MAX_BYTES streaming cap.
 */
export async function fetchSchemaOrg(url: string): Promise<FetchSchemaOrgResult> {
  // Validate URL
  if (!url || typeof url !== "string") {
    return failure("URL is required");
  }

  try {
    const response = await guardedFetch(url, {
      maxBytes: GUARDED_HTML_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT,
      headers: {
        "User-Agent": SCRAPER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      response.cancel();
      return failure(`Failed to fetch page (${response.status})`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      response.cancel();
      return failure("URL does not point to an HTML page");
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
    if (isGuardedFetchError(error)) {
      switch (error.code) {
        case "invalid_url":
        case "blocked_protocol":
        case "blocked_host":
          return failure("Internal URLs are not allowed");
        case "timeout":
          return failure("Page took too long to load");
        case "too_large":
          return failure("Page is too large to fetch");
        default:
          return failure(error.message);
      }
    }
    return failure(error instanceof Error ? error.message : "Failed to fetch page");
  }
}

/**
 * Create an index file to re-export everything
 */
export { parseJsonLd } from "./parser";
export * from "./types";
