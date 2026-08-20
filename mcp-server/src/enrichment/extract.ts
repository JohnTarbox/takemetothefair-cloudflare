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
/**
 * OPE-504 — file extensions that turn up as the final label when a scraper
 * matches an image or asset filename with an `@` in it (retina `@2x`/`@3x`
 * assets are the common source). Never a real mail domain.
 */
const ASSET_EXTENSION_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "bmp",
  "tiff",
  "pdf",
  "css",
  "js",
  "json",
  "xml",
  "zip",
  "mp4",
  "webm",
  "woff",
  "woff2",
]);

const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "godaddy.com",
  // OPE-504 — Wix's default pre-publish domain. Prod candidate 7780 proposed
  // `info@mysite.com` and was caught only by email_domain_mismatch, i.e. by
  // accident; on a vendor whose site really was mysite.com it would pass.
  "mysite.com",
  "mydomain.com",
  "yoursite.com",
  "yourdomain.com",
  "domain.com",
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
export function decodeUrlAndEntities(s: string): string {
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

/**
 * OPE-376 (OPE-249 class, 7th) — true when a canonical phone is fictitious.
 *
 * `normalizePhone` only proves a number is well-FORMED, and well-formed is not
 * the same as real. `(508) 555-9876` satisfies `^[2-9]\d{2}[2-9]\d{6}$`
 * perfectly and staged clean at confidence 0.90 from a site's own JSON-LD —
 * almost certainly template residue the vendor never replaced.
 *
 * Measured in prod 2026-08-13: two such candidates, both still `pending` —
 * `(508) 555-9876` and `(555) 555-5555`. Nothing fake has reached a live vendor
 * page yet, which is exactly why this wants to ship before OPE-374 raises the
 * auto-merge threshold and removes the human who is currently catching them.
 *
 * `555-1212` is deliberately exempt: it is real directory assistance, and a
 * blanket NXX=555 rule would reject a genuine number.
 */
const DIRECTORY_ASSISTANCE_LINE = "1212";

/** Ascending or descending consecutive run, e.g. 2345678 / 8765432. */
function isSequentialRun(digits: string): boolean {
  let asc = true;
  let desc = true;
  for (let i = 1; i < digits.length; i++) {
    const delta = digits.charCodeAt(i) - digits.charCodeAt(i - 1);
    if (delta !== 1) asc = false;
    if (delta !== -1) desc = false;
  }
  return asc || desc;
}

export function isPlaceholderPhone(canonical: string): boolean {
  const digits = canonical.replace(/\D/g, "");
  // Not a canonical 10-digit number → never stage it clean. Mirrors
  // isPlaceholderEmail's treatment of a malformed address.
  if (digits.length !== 10) return true;

  const npa = digits.slice(0, 3);
  const nxx = digits.slice(3, 6);
  const line = digits.slice(6);

  // A 555 AREA code is not assignable to subscribers at all.
  if (npa === "555") return true;
  // 555 as the exchange is the reserved fictional block (555-01xx) plus the
  // stock fakes everyone writes (555-9876, 555-1234).
  if (nxx === "555" && line !== DIRECTORY_ASSISTANCE_LINE) return true;

  const subscriber = nxx + line;
  // 555-5555, 222-2222 — one digit repeated. (000-0000 and 111-1111 never
  // reach here; normalizePhone rejects an NXX starting 0 or 1. Kept anyway so
  // this function is correct standalone, not only downstream of that guard.)
  if (/^(\d)\1{6}$/.test(subscriber)) return true;
  // 234-5678 IS well-formed and DOES reach here, so this check earns its place.
  if (isSequentialRun(subscriber)) return true;

  // OPE-504 — `(800) 800-0000` (prod candidate 7055) reached here CLEAN at
  // confidence 0.90. The repeated-digit test above runs on the whole 7-digit
  // subscriber, so an all-zero LINE number behind a different exchange slips
  // past it. Two narrow tells, both stronger than they look:
  //
  //   * an all-zero line number (`xxx-xxx-0000`)
  //   * the exchange repeating the area code (`800-800-xxxx`)
  //
  // Real switchboards on `-0000` do exist, so this will occasionally be wrong.
  // That is the right trade here: `placeholder_phone` FLAGS for review rather
  // than dropping (OPE-376's deliberate choice), so a false positive costs one
  // human glance, while a false negative writes a fake number onto a live
  // vendor page.
  if (/^0+$/.test(line)) return true;
  if (npa === nxx) return true;

  return false;
}

/**
 * OPE-504 — true when a social URL points at the WEBSITE PLATFORM's own
 * account rather than the vendor's.
 *
 * These come off template footers: a Wix site ships with links to Wix's own
 * Facebook/Twitter/Instagram, and the scraper cannot tell them from the
 * vendor's. Six vendors in one 200-row prod sample carried them, several
 * mixing one placeholder in with genuine handles — so this is applied
 * PER LINK, never per row.
 *
 * Matches the final path segment WHOLE. Substring matching would kill
 * `facebook.com/wixomfarmersmarket`, which is a real Michigan market.
 */
const PLATFORM_PLACEHOLDER_HANDLES = new Set([
  "wix",
  "wixcom",
  "squarespace",
  "shopify",
  "godaddy",
  "weebly",
  "wordpress",
  "wordpressdotcom",
  "webflow",
  "bigcommerce",
  "duda",
  "jimdo",
  "yourbusiness",
  "yourpage",
  "username",
]);

export function isPlatformPlaceholderHandle(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  // `youtube.com/user/Wix` and `youtube.com/c/Wix` put the handle last; so does
  // the plain `facebook.com/wix`. Taking the last segment covers both.
  const handle = segments[segments.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "");
  return PLATFORM_PLACEHOLDER_HANDLES.has(handle);
}

/**
 * OPE-504 — true when this string is not a plausible email address at all.
 *
 * The gate had no format validation. `email_domain_mismatch` was standing in
 * for it, which fails in exactly the case that matters: a malformed value on
 * the vendor's OWN domain. Verified in prod — candidate 7149 proposed
 * `bill.@thirstyrobotbrewing.com` at confidence 0.90 with no flags at all,
 * which is inside the auto-merge predicate.
 *
 * Deliberately NOT a full RFC 5322 implementation. RFC 5322 permits quoted
 * local-parts containing almost anything, so a faithful validator would accept
 * `"bill."@example.com` and defeat the point. This is the pragmatic shape
 * every mail provider actually accepts, which is the right test for "did the
 * scraper pick up a real address".
 */
export function isMalformedEmail(email: string): boolean {
  const e = decodeUrlAndEntities(email).trim();
  if (!e || /\s/.test(e)) return true;

  const at = e.indexOf("@");
  // Exactly one @ — `two@at@example.com` is not an address.
  if (at < 1 || at !== e.lastIndexOf("@")) return true;

  const local = e.slice(0, at);
  const domain = e.slice(at + 1).toLowerCase();

  // Local-part: no leading/trailing dot, no doubled dot.
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return true;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return true;

  // Domain: dot-separated labels, each alphanumeric with interior hyphens,
  // and a final alphabetic TLD of at least two characters.
  const labels = domain.split(".");
  if (labels.length < 2) return true;
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return true;
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return true;

  // `US_Web_AllBrands_Logos_Desktop@3x.png` (prod candidate 7399) is a
  // STRUCTURALLY valid domain — `3x` is a legal label and `png` is alphabetic.
  // The only thing wrong with it is that nobody's mail server lives at a
  // filename, so the rejection has to be a real asset-extension check rather
  // than a cleverer shape rule. Found by the test failing on the first cut.
  if (ASSET_EXTENSION_TLDS.has(tld)) return true;

  return false;
}

/**
 * NOTE: applied at all three extraction sites alongside `isMalformedEmail`, so
 * the vendor, performer AND promoter lanes are covered — `safety-rules.ts`
 * gates only vendors, and it carries its own DIFFERENT function of this name.
 */
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

    // OPE-504 — decode BEFORE storing, not only before validating. The
    // validators call decodeUrlAndEntities internally, so an entity-obfuscated
    // address (`c&#111;&#110;tact&#64;example.com`, a common anti-scraper
    // trick) passed every check and was then stored as the raw entity soup.
    // Eight such rows were pending in prod at confidence 0.8 with no flags —
    // auto-merge-eligible, and they would have written entity text onto a live
    // vendor page. Validation and storage must see the same string.
    const emailRaw =
      typeof node.email === "string"
        ? decodeUrlAndEntities(node.email)
            .replace(/^mailto:/i, "")
            .trim()
        : "";
    // OPE-249 #4 — never stage placeholder/site-builder residue as a contact.
    if (emailRaw && !out.email && !isPlaceholderEmail(emailRaw) && !isMalformedEmail(emailRaw))
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
      // OPE-504 — was decodeBasicEntities, which only handles a fixed NAMED
      // list; the prod rows were numeric (`&#111;`). This is the path that
      // produced them.
      const email = decodeUrlAndEntities(mailto[1]).trim();
      if (email && !isPlaceholderEmail(email) && !isMalformedEmail(email))
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
    if (m && !isPlaceholderEmail(m[0]) && !isMalformedEmail(m[0])) {
      // OPE-249 #5 — a regex email is the weakest signal; without domain
      // affinity (matches the site, or a generic mailbox) it's likely a
      // personal address at a third domain (`kkeating@granitemediagroup.com`).
      // Keep it but drop confidence below the clean bar so it stages flagged.
      const decoded = decodeUrlAndEntities(m[0]).trim(); // OPE-504 — see above
      const affinity = emailHasDomainAffinity(decoded, sourceUrl);
      out.email = { value: decoded, method: "regex", confidence: affinity ? 0.5 : 0.2 };
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
