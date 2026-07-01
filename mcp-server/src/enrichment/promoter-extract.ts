/**
 * Promoter-signal extractor (OPE-36) — pure: HTML → PromoterExtraction.
 *
 * The promoter analog of extract.ts. A promoter's own website is the same
 * shape as a vendor's, so we REUSE extractVendorContact for the contact /
 * social / description signals rather than re-deriving them, and add the one
 * thing promoters care about that vendors don't: the og:image URL (the raw
 * candidate for the hero band + square logo — classified downstream by
 * promoter-image.ts after a Range probe).
 *
 * No network, no DB. promoter-dispatch.ts is the only piece that fetches or
 * writes.
 */
import type { ExtractionMethod } from "./types.js";
import { extractVendorContact } from "./extract.js";

/** Extraction methods a promoter signal can carry (vendor set + og:image). */
export type PromoterExtractionMethod = ExtractionMethod | "og-image";

export interface PromoterSignal {
  value: string;
  method: PromoterExtractionMethod;
  confidence: number;
}

/** Raw, pre-safety extraction from a single promoter page. */
export interface PromoterExtraction {
  /** og:image / twitter:image URL (absolute), un-probed. Feeds hero+logo. */
  ogImage?: string;
  /** Meta / og description (highest-confidence prose available). */
  description?: PromoterSignal;
  /** platform→url JSON string, e.g. {"facebook":"https://facebook.com/x"}. */
  socialLinks?: PromoterSignal;
  contactEmail?: PromoterSignal;
  contactPhone?: PromoterSignal;
  /** <title> text + cleaned body — carried through for parity with the vendor
   *  extraction; callers may use them for future marker scans. */
  pageTitle?: string;
  bodyText?: string;
}

/** Resolve a possibly-relative og:image URL against the page it came from. */
function absoluteUrl(raw: string, baseUrl: string): string {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

/**
 * Extract the og:image (preferred) or twitter:image (fallback) URL. Mirrors
 * the regex in src/lib/url-import/html-parser.ts:extractMetadata — the parser
 * itself isn't importable from the MCP package (it pulls the app's `@/`
 * alias), so the identical pattern lives here.
 */
function extractOgImageUrl(html: string, baseUrl: string): string | undefined {
  const og =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i);
  if (og) return absoluteUrl(og[1].trim(), baseUrl);
  const tw =
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i);
  if (tw) return absoluteUrl(tw[1].trim(), baseUrl);
  return undefined;
}

/**
 * Pull promoter enrichment signals from a rendered page. Contact / social /
 * description come from the shared vendor extractor (identical semantics);
 * og:image is promoter-specific.
 */
export function extractPromoterSignals(html: string, sourceUrl: string): PromoterExtraction {
  const v = extractVendorContact(html, sourceUrl);
  const out: PromoterExtraction = {};

  const og = extractOgImageUrl(html, sourceUrl);
  if (og) out.ogImage = og;

  if (v.description) {
    out.description = {
      value: v.description.value,
      method: v.description.method,
      confidence: v.description.confidence,
    };
  }
  if (v.social) {
    out.socialLinks = {
      value: JSON.stringify(v.social.value),
      method: v.social.method,
      confidence: v.social.confidence,
    };
  }
  if (v.email) {
    out.contactEmail = {
      value: v.email.value,
      method: v.email.method,
      confidence: v.email.confidence,
    };
  }
  if (v.phone) {
    out.contactPhone = {
      value: v.phone.value,
      method: v.phone.method,
      confidence: v.phone.confidence,
    };
  }
  if (v.pageTitle) out.pageTitle = v.pageTitle;
  if (v.bodyText) out.bodyText = v.bodyText;

  return out;
}
