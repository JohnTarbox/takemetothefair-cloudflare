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

// ── OPE-249 — extractor hardening (6 defect classes from the 2026-07-17 batch review) ──

/** OPE-249 #4 — placeholder / site-builder-residue email domains + local-parts
 *  that must never stage as a real contact. */
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "godaddy.com",
  "wix.com",
  "wixpress.com",
  "squarespace.com",
  "example.com",
  "example.org",
  "example.net",
  "sentry.io",
  "email.com",
]);
const PLACEHOLDER_EMAIL_LOCALPARTS = new Set([
  "filler",
  "test",
  "test123",
  "email",
  "you",
  "your",
  "name",
  "username",
  "sentry",
]);

/** OPE-249 #5 — generic-mailbox prefixes that are legitimately an org's public
 *  contact even when the mailbox domain differs from the site (a business may
 *  route info@ through a third-party). A PERSONAL name at a third domain is not. */
const GENERIC_MAILBOX_LOCALPARTS = new Set([
  "info",
  "contact",
  "hello",
  "office",
  "hi",
  "admin",
  "mail",
  "events",
  "booking",
  "bookings",
  "sales",
  "support",
]);

/** Decode `%XX` URL-encoding AND numeric/hex HTML entities, then basic named
 *  entities — the layers that made cited tel values dirty
 *  (`%20(603)…`, `&#x2B;1(207)…`). */
function decodeUrlAndEntities(s: string): string {
  let out = s;
  if (out.includes("%")) {
    try {
      out = decodeURIComponent(out);
    } catch {
      // Leave malformed %XX as-is; the digit extraction below still works.
    }
  }
  out = out
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)));
  return decodeBasicEntities(out);
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/**
 * OPE-249 #1 — normalize a raw phone value to canonical `(NPA) NXX-XXXX`, or
 * null when it isn't a valid North-American number. URL/entity-decodes first,
 * strips a US country code, then enforces NANP: 10 digits, area code and
 * exchange each starting 2-9. Rejects the cited "1846151813" (area 184) — a
 * numeric id mis-scraped as a phone.
 */
export function normalizePhone(raw: string): string | null {
  let digits = decodeUrlAndEntities(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** OPE-249 #4 — true when this address is site-builder/placeholder residue. */
export function isPlaceholderEmail(email: string): boolean {
  const e = decodeUrlAndEntities(email).toLowerCase().trim();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return true; // malformed → never stage clean
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return true;
  if (domain.endsWith(".wixpress.com") || domain.endsWith(".sentry.io")) return true;
  if (PLACEHOLDER_EMAIL_LOCALPARTS.has(local)) return true;
  return false;
}

/** registrable-ish host of a URL, lowercased, no leading www. Null on parse fail. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * OPE-249 #5 — a regex-scraped email is trustworthy as the org's public contact
 * only when its domain matches the site OR it's a generic mailbox. A personal
 * name at a THIRD domain (the cited `kkeating@granitemediagroup.com`) is not.
 */
export function emailHasDomainAffinity(email: string, sourceUrl: string): boolean {
  const e = email.toLowerCase().trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return false;
  const local = e.slice(0, at);
  const emailDomain = e.slice(at + 1);
  if (GENERIC_MAILBOX_LOCALPARTS.has(local)) return true;
  const site = hostOf(sourceUrl);
  if (!site) return false;
  // Same registrable domain (or a subdomain match either direction).
  return (
    emailDomain === site || emailDomain.endsWith(`.${site}`) || site.endsWith(`.${emailDomain}`)
  );
}

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
  const host = u.hostname.toLowerCase();
  const platform = SOCIAL_HOSTS[host];
  if (!platform) return null;
  // A bare profile root (no handle) is useless.
  if (u.pathname === "/" || u.pathname === "") return null;

  // OPE-249 #2 — YouTube: a video/short link is NOT the org's channel.
  // youtu.be/* is always a share link; /watch and /shorts are videos. Accept
  // only channel/user/custom/@handle forms.
  if (platform === "youtube") {
    if (host === "youtu.be") return null;
    const isChannel = /^\/(channel|user|c)\//i.test(u.pathname) || /^\/@[\w.-]+/.test(u.pathname);
    if (!isChannel) return null;
  }

  // OPE-249 #3 — Instagram: a hashtag/explore/post/reel URL is NOT a profile.
  if (platform === "instagram") {
    if (/^\/(explore|tags|p|reel|reels|tv|stories)(\/|$)/i.test(u.pathname)) return null;
  }

  return { platform, url: u.toString() };
}

export function extractVendorContact(html: string, sourceUrl: string): VendorExtraction {
  const out: VendorExtraction = {};
  const social: Record<string, string> = {};
  let socialMethod: ExtractionMethod = "social-link";
  // OPE-249 #6 — collect every DISTINCT address the page's JSON-LD carries
  // (keyed by street|locality|region, so the same address repeated across an
  // Organization + LocalBusiness node counts once). A multi-location business
  // (the cited Bright Ideas Brewing: home North Adams + satellite Westfield)
  // yields more than one; the pure extractor can't know which is THIS record's
  // home, so it must stage none. Emission is decoupled from having a street —
  // a page can carry only city/state.
  const addressCandidates = new Map<string, { street: string; locality: string; region: string }>();

  // --- 1. JSON-LD (highest confidence) ---
  for (const node of parseJsonLdNodes(html)) {
    const telRaw = typeof node.telephone === "string" ? node.telephone : "";
    const tel = normalizePhone(telRaw); // OPE-249 #1
    if (tel && !out.phone) out.phone = { value: tel, method: "jsonld", confidence: 0.9 };

    const emailRaw =
      typeof node.email === "string" ? node.email.replace(/^mailto:/i, "").trim() : "";
    // OPE-249 #4 — never stage placeholder/site-builder residue as a contact.
    if (emailRaw && !out.email && !isPlaceholderEmail(emailRaw))
      out.email = { value: emailRaw, method: "jsonld", confidence: 0.9 };

    const addr = node.address;
    if (addr && typeof addr === "object" && !Array.isArray(addr)) {
      const a = addr as Record<string, unknown>;
      const street = typeof a.streetAddress === "string" ? a.streetAddress.trim() : "";
      const locality = typeof a.addressLocality === "string" ? a.addressLocality.trim() : "";
      const region = typeof a.addressRegion === "string" ? a.addressRegion.trim() : "";
      if (street || locality || region) {
        const key = `${street}|${locality}|${region}`.toLowerCase();
        addressCandidates.set(key, { street, locality, region });
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

  // OPE-249 #6 — emit a JSON-LD address ONLY when the page names exactly one.
  // Multiple distinct streets = a multi-location business; staging any of them
  // against this single record would mis-assign (the Bright Ideas case).
  if (addressCandidates.size === 1) {
    const only = [...addressCandidates.values()][0];
    if (only.street) out.address = { value: only.street, method: "jsonld", confidence: 0.85 };
    if (only.locality) out.city = { value: only.locality, method: "jsonld", confidence: 0.85 };
    const st = only.region.toUpperCase();
    if (st && US_STATE_ABBR.has(st)) out.state = { value: st, method: "jsonld", confidence: 0.85 };
  }

  // --- 2. mailto: / tel: anchors ---
  if (!out.email) {
    const mailto = html.match(/href=["']mailto:([^"'?]+)/i);
    if (mailto) {
      const email = decodeBasicEntities(mailto[1]).trim();
      if (email && !isPlaceholderEmail(email))
        // OPE-249 #4
        out.email = { value: email, method: "mailto", confidence: 0.8 };
    }
  }
  if (!out.phone) {
    const tel = html.match(/href=["']tel:([^"']+)/i);
    if (tel) {
      const normalized = normalizePhone(tel[1]); // OPE-249 #1
      if (normalized) out.phone = { value: normalized, method: "tel", confidence: 0.8 };
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
    if (m && !isPlaceholderEmail(m[0])) {
      // OPE-249 #5 — a regex email is the weakest signal; without domain
      // affinity (matches the site, or a generic mailbox) it's likely a
      // personal address at a third domain (`kkeating@granitemediagroup.com`).
      // Keep it but drop confidence below the clean bar so it stages flagged.
      const affinity = emailHasDomainAffinity(m[0], sourceUrl);
      out.email = { value: m[0], method: "regex", confidence: affinity ? 0.5 : 0.2 };
    }
  }
  if (!out.phone) {
    const m = text.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
    if (m) {
      const normalized = normalizePhone(m[1]); // OPE-249 #1
      if (normalized) out.phone = { value: normalized, method: "regex", confidence: 0.45 };
    }
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
