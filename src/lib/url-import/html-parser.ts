import type { PageMetadata } from "./types";

const MAX_CONTENT_LENGTH = 50 * 1024; // 50KB limit for AI processing

/**
 * HTML entity decode map for common entities
 */
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&ndash;": "-",
  "&mdash;": "-",
  "&copy;": "(c)",
  "&reg;": "(R)",
  "&trade;": "(TM)",
  "&bull;": "*",
  "&hellip;": "...",
};

/**
 * Decode HTML entities in text
 */
function decodeHtmlEntities(text: string): string {
  // Replace named entities
  let decoded = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.replace(new RegExp(entity, "gi"), char);
  }

  // Replace numeric entities (decimal)
  decoded = decoded.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );

  // Replace numeric entities (hex)
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );

  return decoded;
}

/**
 * Extract plain text content from HTML, stripping tags and scripts
 */
export function extractTextFromHtml(html: string): string {
  // Remove script and style tags with their content
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Convert block elements to newlines for better readability
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n");
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  // Limit content length
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "\n[Content truncated...]";
  }

  return text;
}

/**
 * Extract metadata from HTML including title, Open Graph, and JSON-LD
 */
export function extractMetadata(html: string): PageMetadata {
  const metadata: PageMetadata = {};

  // Extract title tag
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    metadata.title = decodeHtmlEntities(titleMatch[1].trim());
  }

  // Extract og:title if no title
  if (!metadata.title) {
    const ogTitleMatch = html.match(
      /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i
    );
    if (ogTitleMatch) {
      metadata.title = decodeHtmlEntities(ogTitleMatch[1].trim());
    }
  }

  // Extract og:image
  const ogImageMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i
  );
  if (ogImageMatch) {
    metadata.ogImage = ogImageMatch[1].trim();
  }

  // Also check for content before property (different attribute order)
  if (!metadata.ogImage) {
    const ogImageMatch2 = html.match(
      /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i
    );
    if (ogImageMatch2) {
      metadata.ogImage = ogImageMatch2[1].trim();
    }
  }

  // Extract JSON-LD structured data
  const jsonLdMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of jsonLdMatches) {
    try {
      const jsonData = JSON.parse(match[1].trim());

      // Look for Event schema
      if (jsonData["@type"] === "Event" || jsonData["@type"]?.includes("Event")) {
        metadata.jsonLd = jsonData;
        break;
      }

      // Check if it's an array of schemas
      if (Array.isArray(jsonData)) {
        const eventSchema = jsonData.find(
          (item) =>
            item["@type"] === "Event" || item["@type"]?.includes("Event")
        );
        if (eventSchema) {
          metadata.jsonLd = eventSchema;
          break;
        }
      }

      // Check for @graph pattern
      if (jsonData["@graph"] && Array.isArray(jsonData["@graph"])) {
        const eventSchema = jsonData["@graph"].find(
          (item: Record<string, unknown>) =>
            item["@type"] === "Event" || (item["@type"] as string[])?.includes?.("Event")
        );
        if (eventSchema) {
          metadata.jsonLd = eventSchema;
          break;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  return metadata;
}

/**
 * Extract all links from HTML
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkMatches = html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi);

  for (const match of linkMatches) {
    try {
      const url = new URL(match[1], baseUrl);
      links.push(url.href);
    } catch {
      // Ignore invalid URLs
    }
  }

  return [...new Set(links)];
}
