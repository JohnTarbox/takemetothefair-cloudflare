/**
 * Deterministic extractor: lift an event name from page signals when the
 * AI didn't produce one. Priority order, highest first:
 *   1. OG `og:title` (already in PageMetadata.title via html-parser)
 *   2. First `<h1>` from raw HTML
 *   3. First `<h2>` from raw HTML
 *   4. URL slug — last path segment with dashes → spaces, title-cased
 *
 * Strips common WordPress / event-plugin chrome suffixes:
 *   "Foo Festival | Big Town Chamber" → "Foo Festival"
 *   "Foo Festival - Big Town Chamber" → "Foo Festival" (only when chamber-like)
 *
 * Used in compose.ts: deterministic name lookup runs in parallel with date-
 * regex; both feed the final synthesized event when AI extraction returned
 * zero events.
 */

import type { PageMetadata } from "../types";

/**
 * Return the best deterministic event-name guess, or null when no signal
 * yields a plausible name. Never throws.
 */
export function findEventName(
  html: string,
  metadata: PageMetadata | undefined,
  url: string | undefined
): string | null {
  const candidates: string[] = [];

  if (metadata?.title && metadata.title.trim().length > 0) {
    candidates.push(metadata.title.trim());
  }

  const h1 = firstTagText(html, "h1");
  if (h1) candidates.push(h1);

  const h2 = firstTagText(html, "h2");
  if (h2) candidates.push(h2);

  if (url) {
    const fromSlug = nameFromSlug(url);
    if (fromSlug) candidates.push(fromSlug);
  }

  for (const raw of candidates) {
    const cleaned = stripChrome(raw);
    if (cleaned.length >= 4 && cleaned.length <= 200) return cleaned;
  }

  return null;
}

function firstTagText(html: string, tag: "h1" | "h2"): string | null {
  // Tolerate attributes on the opening tag, multi-line content, and inner
  // markup like <span>. Strip inner tags to get the plain text.
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = html.match(re);
  if (!match) return null;
  const inner = match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return inner.length > 0 ? inner : null;
}

function nameFromSlug(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  // Last non-empty segment, ignoring trailing slash and common index files.
  const segments = path.split("/").filter((s) => s && s !== "index.html" && s !== "index.php");
  const last = segments[segments.length - 1];
  if (!last) return null;
  // Drop a year suffix like "-2026" so the candidate has more weight at the
  // dedup step (the dedup normalize already strips year suffixes — keeping
  // both shapes around adds nothing).
  const noExt = last.replace(/\.(html?|php|aspx?)$/i, "");
  // Skip if the slug is just digits or shorter than 4 chars after split.
  if (/^\d+$/.test(noExt) || noExt.length < 4) return null;
  return noExt
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Strip "<title> | <site-name>" / "<title> - <site-name>" trailing chrome.
 * Heuristic: a tail after " | " or " - " that contains "chamber", "fair",
 * "calendar", "events", "website" is chrome to drop; otherwise leave it
 * alone (the tail might be part of the event name itself).
 */
function stripChrome(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const pipeIdx = trimmed.indexOf(" | ");
  if (pipeIdx > 0) {
    return trimmed.slice(0, pipeIdx).trim();
  }
  // For ' - ' we're more conservative: only strip when the tail looks like
  // site chrome.
  const dashIdx = trimmed.lastIndexOf(" - ");
  if (dashIdx > 0) {
    const tail = trimmed.slice(dashIdx + 3).toLowerCase();
    if (/chamber|calendar|events|website|directory|home|tourism/.test(tail)) {
      return trimmed.slice(0, dashIdx).trim();
    }
  }
  return trimmed;
}
