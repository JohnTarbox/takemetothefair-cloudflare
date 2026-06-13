/**
 * Vendor-contact extractor (I1, 2026-06-13). Pure: HTML → VendorExtraction.
 *
 * Source priority (highest confidence first):
 *   1. JSON-LD LocalBusiness/Organization — telephone, email, address, sameAs
 *   2. mailto: / tel: anchors
 *   3. Anchor links to known social platforms
 *   4. Conservative regex over cleaned text (lowest confidence)
 *
 * No network, no DB. The safety rules (safety-rules.ts) decide what survives.
 */
import type { ExtractionMethod, VendorExtraction } from "./types.js";

/** host (registrable-ish) → social platform key. */
const SOCIAL_HOSTS: Record<string, string> = {
  "facebook.com": "facebook",
  "www.facebook.com": "facebook",
  "m.facebook.com": "facebook",
  "fb.com": "facebook",
  "instagram.com": "instagram",
  "www.instagram.com": "instagram",
  "twitter.com": "twitter",
  "www.twitter.com": "twitter",
  "x.com": "twitter",
  "www.x.com": "twitter",
  "tiktok.com": "tiktok",
  "www.tiktok.com": "tiktok",
  "youtube.com": "youtube",
  "www.youtube.com": "youtube",
  "youtu.be": "youtube",
  "linkedin.com": "linkedin",
  "www.linkedin.com": "linkedin",
};

/** Share-intent / widget paths that are never a vendor's own profile. */
const SOCIAL_JUNK_PATH = /\/(sharer|share|intent|plugins|dialog|tr\b|embed)/i;

const US_STATE_ABBR = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Strip tags/scripts/styles → collapsed visible text. */
function toText(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}

/** Parse every JSON-LD block, flattening @graph + arrays into a node list. */
function parseJsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const m of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack: unknown[] = [data];
    while (stack.length) {
      const cur = stack.pop();
      if (Array.isArray(cur)) {
        stack.push(...cur);
      } else if (cur && typeof cur === "object") {
        const obj = cur as Record<string, unknown>;
        nodes.push(obj);
        if (Array.isArray(obj["@graph"])) stack.push(...(obj["@graph"] as unknown[]));
      }
    }
  }
  return nodes;
}

function socialFromUrl(rawUrl: string): { platform: string; url: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (SOCIAL_JUNK_PATH.test(u.pathname)) return null;
  const platform = SOCIAL_HOSTS[u.hostname.toLowerCase()];
  if (!platform) return null;
  // A bare profile root (no handle) is useless.
  if (u.pathname === "/" || u.pathname === "") return null;
  return { platform, url: u.toString() };
}

export function extractVendorContact(html: string, _sourceUrl: string): VendorExtraction {
  const out: VendorExtraction = {};
  const social: Record<string, string> = {};
  let socialMethod: ExtractionMethod = "social-link";

  // --- 1. JSON-LD (highest confidence) ---
  for (const node of parseJsonLdNodes(html)) {
    const tel = typeof node.telephone === "string" ? node.telephone.trim() : "";
    if (tel && !out.phone) out.phone = { value: tel, method: "jsonld", confidence: 0.9 };

    const email = typeof node.email === "string" ? node.email.replace(/^mailto:/i, "").trim() : "";
    if (email && !out.email) out.email = { value: email, method: "jsonld", confidence: 0.9 };

    const addr = node.address;
    if (addr && typeof addr === "object" && !Array.isArray(addr)) {
      const a = addr as Record<string, unknown>;
      const street = typeof a.streetAddress === "string" ? a.streetAddress.trim() : "";
      const locality = typeof a.addressLocality === "string" ? a.addressLocality.trim() : "";
      const region = typeof a.addressRegion === "string" ? a.addressRegion.trim() : "";
      if (street && !out.address)
        out.address = { value: street, method: "jsonld", confidence: 0.85 };
      if (locality && !out.city) out.city = { value: locality, method: "jsonld", confidence: 0.85 };
      if (region && !out.state) {
        const st = region.toUpperCase();
        if (US_STATE_ABBR.has(st)) out.state = { value: st, method: "jsonld", confidence: 0.85 };
      }
    }

    const sameAs = node.sameAs;
    const sameAsList = Array.isArray(sameAs) ? sameAs : typeof sameAs === "string" ? [sameAs] : [];
    for (const link of sameAsList) {
      if (typeof link !== "string") continue;
      const s = socialFromUrl(link);
      if (s && !social[s.platform]) {
        social[s.platform] = s.url;
        socialMethod = "jsonld";
      }
    }
  }

  // --- 2. mailto: / tel: anchors ---
  if (!out.email) {
    const mailto = html.match(/href=["']mailto:([^"'?]+)/i);
    if (mailto)
      out.email = {
        value: decodeBasicEntities(mailto[1]).trim(),
        method: "mailto",
        confidence: 0.8,
      };
  }
  if (!out.phone) {
    const tel = html.match(/href=["']tel:([^"']+)/i);
    if (tel) {
      const digits = tel[1].replace(/[^\d+]/g, "");
      if (digits.replace(/\D/g, "").length >= 10)
        out.phone = { value: tel[1].trim(), method: "tel", confidence: 0.8 };
    }
  }

  // --- 3. social anchors ---
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const s = socialFromUrl(m[1]);
    if (s && !social[s.platform]) social[s.platform] = s.url;
  }

  // --- 4. regex fallbacks (lowest confidence) ---
  const text = toText(html);
  out.bodyText = text.slice(0, 20000);
  if (!out.email) {
    const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (m) out.email = { value: m[0], method: "regex", confidence: 0.5 };
  }
  if (!out.phone) {
    const m = text.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
    if (m) out.phone = { value: m[1].trim(), method: "regex", confidence: 0.45 };
  }

  if (Object.keys(social).length > 0) {
    out.social = {
      value: social,
      method: socialMethod,
      confidence: socialMethod === "jsonld" ? 0.85 : 0.6,
    };
  }

  // --- title + description ---
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title) out.pageTitle = decodeBasicEntities(title[1]);

  const metaDesc =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  if (metaDesc) {
    const d = decodeBasicEntities(metaDesc[1]);
    if (d.length >= 20) out.description = { value: d, method: "regex", confidence: 0.5 };
  }

  return out;
}
