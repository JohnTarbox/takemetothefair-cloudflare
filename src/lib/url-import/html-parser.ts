import type { PageMetadata } from "./types";
import { decodeHtmlEntities } from "@/lib/utils";

const MAX_CONTENT_LENGTH = 50 * 1024; // 50KB limit for AI processing

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

  // Extract meta description (often contains date/time info)
  const descriptionMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i
  );
  if (descriptionMatch) {
    metadata.description = decodeHtmlEntities(descriptionMatch[1].trim());
  }
  // Also check for content before name
  if (!metadata.description) {
    const descriptionMatch2 = html.match(
      /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i
    );
    if (descriptionMatch2) {
      metadata.description = decodeHtmlEntities(descriptionMatch2[1].trim());
    }
  }

  // Extract og:description as fallback
  if (!metadata.description) {
    const ogDescMatch = html.match(
      /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i
    );
    if (ogDescMatch) {
      metadata.description = decodeHtmlEntities(ogDescMatch[1].trim());
    }
  }

  // Extract JSON-LD structured data. Collects ALL Event-schema nodes
  // (analyst 2026-05-22 P7a) — `metadata.jsonLdEvents` carries the full
  // list, `metadata.jsonLd` keeps the first for back-compat with callers
  // not yet upgraded to the multi-event API.
  const jsonLdMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  const allEvents: Record<string, unknown>[] = [];
  for (const match of jsonLdMatches) {
    try {
      const jsonData = JSON.parse(match[1].trim());

      // Bare Event schema object
      if (isEventSchema(jsonData)) {
        allEvents.push(jsonData);
        continue;
      }

      // Array of schemas (some sites emit one <script> per type)
      if (Array.isArray(jsonData)) {
        for (const item of jsonData) {
          if (isEventSchema(item)) allEvents.push(item);
        }
        continue;
      }

      // @graph pattern (WordPress plugins like Yoast SEO use this)
      if (jsonData["@graph"] && Array.isArray(jsonData["@graph"])) {
        for (const item of jsonData["@graph"]) {
          if (isEventSchema(item)) allEvents.push(item as Record<string, unknown>);
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  if (allEvents.length > 0) {
    metadata.jsonLdEvents = allEvents;
    metadata.jsonLd = allEvents[0]; // back-compat
  }

  return metadata;
}

/**
 * Schema.org Event types we treat as event-bearing. Subset of the full
 * Event subclass tree — covers the WordPress plugin output we see most
 * often (The Events Calendar, EventOn, Events Manager all emit one of
 * these) without the niche types (CourseInstance, DeliveryEvent, etc.)
 * that are unlikely to be a fair / market submission.
 */
const EVENT_SCHEMA_TYPES = new Set([
  "Event",
  "BusinessEvent",
  "ChildrensEvent",
  "ComedyEvent",
  "DanceEvent",
  "EducationEvent",
  "ExhibitionEvent",
  "Festival",
  "FoodEvent",
  "Hackathon",
  "LiteraryEvent",
  "MusicEvent",
  "SaleEvent",
  "ScreeningEvent",
  "SocialEvent",
  "SportsEvent",
  "TheaterEvent",
  "VisualArtsEvent",
]);

/**
 * Does this JSON-LD node represent an Event we can extract from? Tolerates:
 *   - @type: "Event" (string)
 *   - @type: ["Event", "MusicEvent"] (array — schema.org allows multi-typing)
 *   - @type: "schema:Event" (rare prefixed form)
 * Doesn't fire on accidental substrings like "EventReservation" — the
 * older `.includes("Event")` heuristic in this file was vulnerable to that.
 */
function isEventSchema(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object") return false;
  const t = (node as Record<string, unknown>)["@type"];
  if (typeof t === "string") {
    return EVENT_SCHEMA_TYPES.has(stripSchemaPrefix(t));
  }
  if (Array.isArray(t)) {
    return t.some((x) => typeof x === "string" && EVENT_SCHEMA_TYPES.has(stripSchemaPrefix(x)));
  }
  return false;
}

function stripSchemaPrefix(t: string): string {
  return t.replace(/^schema:/i, "");
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

/**
 * OPE-837 — anchors with their VISIBLE TEXT, for same-site page discovery.
 *
 * `extractLinks` above returns hrefs only. That is not enough to decide what a
 * page is before fetching it: on a WordPress site every nav link is
 * `?page_id=<N>`, so the href carries no signal at all and the anchor text
 * ("Tickets", "Artisan Vendors") is the only thing that says what is behind
 * the link. Discovery has to choose what to fetch BEFORE fetching, so the text
 * has to come back with the href.
 *
 * Kept separate from `extractLinks` rather than changing its return type —
 * that function has its own callers' expectations and its own tests.
 */
export function extractAnchors(
  html: string,
  baseUrl: string
): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href: string;
    try {
      href = new URL(match[1], baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);

    // Inner markup (an <img> or a <span> wrapper) is stripped; entities are
    // decoded so "Film, Cheese &amp; Wine" classifies on real characters.
    const text = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();

    out.push({ url: href, text: text.slice(0, 160) });
    // A hard ceiling: a link-farm footer must not turn one fetch into a
    // megabyte of step output.
    if (out.length >= 400) break;
  }

  return out;
}
