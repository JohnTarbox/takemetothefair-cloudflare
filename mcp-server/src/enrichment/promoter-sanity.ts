/**
 * OPE-1706 — four cheap sanity checks on promoter-enrichment proposals. Pure:
 * no network, no DB. Each check only ADDS a flag; applyFills already skips any
 * flagged proposal, so a flag on a contact field is what sends it to review
 * instead of auto-applying. Logos never auto-apply, so their flags only tell
 * the reviewer why to look.
 *
 * Specimens (one daily drain, 2026-11-22):
 *   - Purity Spring Resort (NH) auto-merged `(605) 367-8896` from JSON-LD that
 *     also carried a 949 number and another business's social accounts.
 *   - City of Portsmouth auto-merged `hotline@portsmouthnh.gov`.
 *   - Love Burlington staged a jumpstory stock photo as its logo, unflagged.
 *
 * OPE-1714 — two more logo shapes (2026-11-26 drain):
 *   - North Shore Pride staged `…/Eastern-Bank-Logo.jpg` from its OWN site: a
 *     sponsor's logo, which logo_offsite cannot see → logo_other_org_name.
 *   - Clark Farms and Greater Old Saybrook Chamber staged favicons → logo_favicon.
 */

export type PromoterSanityFlag =
  | "phone_region_mismatch"
  | "jsonld_multiple_entities"
  | "email_role_address"
  | "logo_offsite"
  | "logo_stock_photo"
  | "logo_other_org_name"
  | "logo_favicon";

/** One-line reason per flag, for the review row. Exported for the review tool. */
export const PROMOTER_FLAG_REASONS: Record<string, string> = {
  phone_region_mismatch: "Phone area code is not in the promoter's state (and not toll-free).",
  jsonld_multiple_entities:
    "The page's JSON-LD describes more than one business (several phones, or social accounts that are not the promoter's).",
  email_role_address:
    "Email is a role mailbox (hotline@, webmaster@, …), not a contact for the promoter.",
  logo_offsite: "Logo is hosted off the promoter's own site and not on a known site-builder CDN.",
  logo_stock_photo: "Logo URL names a stock-photo service.",
  logo_other_org_name:
    "Logo filename names a different organization (or sits under a sponsor/partner path) — likely a sponsor's logo.",
  logo_favicon: "Logo is a favicon (named favicon, or under 128px on its short side).",
  // Pre-existing flags, so every row a reviewer sees carries a reason.
  social_no_name_affinity: "No social handle shares a name with the promoter or its website.",
  previously_reverted: "A human reverted this exact value before.",
  previously_rejected: "A human rejected this exact value before.",
  social_mixed_affinity:
    "JSON-LD social payload mixes the promoter's accounts with accounts that are not its own.",
  contact_page_multiple: "Picked from a Contact page that lists several people.",
};

/** Map each flag to its reason; unknown flags get a generic line rather than vanishing. */
export function flagReasons(flags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) out[f] = PROMOTER_FLAG_REASONS[f] ?? "Safety flag (no description).";
  return out;
}

/** New England area codes by state (the catalog's home turf), per the ticket. */
const STATE_AREA_CODES: Record<string, readonly string[]> = {
  ME: ["207"],
  NH: ["603"],
  VT: ["802"],
  MA: ["339", "351", "413", "508", "617", "774", "781", "857", "978"],
  CT: ["203", "475", "860", "959"],
  RI: ["401"],
};

const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/** The 3-digit NANP area code of a phone, or null. */
export function areaCodeOf(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits.slice(0, 3) : null;
}

/**
 * True when the promoter's state is a New England state we hold a complete
 * list for, and the area code is neither one of that state's nor toll-free.
 * Outside New England we have no complete list, so we never flag: a missing
 * entry must not read as a mismatch.
 */
export function phoneRegionMismatch(phone: string, state: string | null | undefined): boolean {
  const codes = STATE_AREA_CODES[(state ?? "").trim().toUpperCase()];
  if (!codes) return false;
  const ac = areaCodeOf(phone);
  if (!ac) return false;
  return !TOLL_FREE.has(ac) && !codes.includes(ac);
}

const ROLE_LOCAL_PARTS = new Set([
  "hotline",
  "abuse",
  "webmaster",
  "postmaster",
  "noreply",
  "no-reply",
  "donotreply",
  "privacy",
  "security",
  "legal",
  "billing",
  "careers",
  "jobs",
  "hr",
]);

/** `hotline@…`, `webmaster@…` and the like. `info@`, `contact@`, `hello@` pass. */
export function isRoleAddress(email: string): boolean {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  return ROLE_LOCAL_PARTS.has(local);
}

/** Host without `www.`, or null. */
function hostOf(url: string | null | undefined): string | null {
  try {
    return new URL(url ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const sameOrSub = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

/** Site-builder image CDNs: an image here is the site's own, wherever it is hosted. */
const BUILDER_CDN_SUFFIXES = [
  "wixstatic.com",
  "squarespace-cdn.com",
  "squarespace.com",
  "wp.com",
  "wsimg.com",
  "sites.google.com",
  "googleusercontent.com",
  "cdn.shopify.com",
  "shopifycdn.com",
  "shopifycdn.net",
];

/**
 * True when the image is hosted neither on the promoter's own site (its
 * `website`, or the page the fetch actually landed on) nor on a known
 * site-builder CDN. Carroll County RSVP's Festival of Trees logo is on the
 * promoter's own `website` domain, so it is NOT offsite.
 */
export function logoOffsite(
  imageUrl: string,
  ownUrls: readonly (string | null | undefined)[]
): boolean {
  const host = hostOf(imageUrl);
  if (!host) return false;
  for (const own of ownUrls) {
    const o = hostOf(own);
    if (o && (sameOrSub(host, o) || sameOrSub(o, host))) return false;
  }
  return !BUILDER_CDN_SUFFIXES.some((s) => sameOrSub(host, s));
}

const STOCK_PHOTO_MARKERS = [
  "jumpstory",
  "shutterstock",
  "istock",
  "gettyimages",
  "adobestock",
  "depositphotos",
  "dreamstime",
  "pexels",
  "unsplash",
  "pixabay",
];

/** The URL's host, path or filename names a stock-photo service. */
export function logoStockPhoto(imageUrl: string): boolean {
  const u = imageUrl.toLowerCase();
  return STOCK_PHOTO_MARKERS.some((m) => u.includes(m));
}

/** Short side below this is an icon, not a logo a page can show (OPE-1714). */
export const FAVICON_MAX_SHORT_SIDE = 128;

/** Path segments of a URL, lowercased and decoded; [] when it does not parse. */
function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg).toLowerCase();
        } catch {
          return seg.toLowerCase();
        }
      });
  } catch {
    return [];
  }
}

/** The probed image is under FAVICON_MAX_SHORT_SIDE on its short side. Unmeasured → false. */
export function logoBelowIconSize(width?: number | null, height?: number | null): boolean {
  if (!width || !height || width <= 0 || height <= 0) return false;
  return Math.min(width, height) < FAVICON_MAX_SHORT_SIDE;
}

/**
 * OPE-1714 — a favicon staged as a logo: the path names `favicon` (or an
 * apple-touch-icon), or the probed image is under FAVICON_MAX_SHORT_SIDE on its
 * short side. Dimensions are optional; the probe cannot always measure.
 */
export function logoFavicon(
  imageUrl: string,
  width?: number | null,
  height?: number | null
): boolean {
  const path = pathSegments(imageUrl).join("/");
  return /favicon|apple-touch-icon/.test(path) || logoBelowIconSize(width, height);
}

/** Words that appear in logo filenames without naming anyone. */
const LOGO_FILENAME_NOISE = new Set([
  "logo",
  "logos",
  "icon",
  "the",
  "and",
  "new",
  "final",
  "web",
  "site",
  "main",
  "header",
  "footer",
  "small",
  "large",
  "medium",
  "full",
  "color",
  "colour",
  "white",
  "black",
  "dark",
  "light",
  "transparent",
  "trans",
  "scaled",
  "cropped",
  "copy",
  "min",
  "retina",
  "png",
  "jpg",
  "jpeg",
  "svg",
  "webp",
  "gif",
]);

/** Name words too common to show affinity on their own. */
const NAME_STOPWORDS = new Set(["the", "and", "of", "inc", "llc", "for", "at", "in", "co"]);

/** Lowercased alphanumeric tokens (callers apply their own length floor). */
function wordTokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * OPE-1714 — the logo names a DIFFERENT organization. Two triggers:
 *   1. the path has a `sponsor`/`partner` segment (…/sponsors/…, partner-logos);
 *   2. the filename contains `logo` and every naming word left after dropping
 *      noise (sizes, colours, `scaled`, WordPress suffixes) has no affinity with
 *      the promoter: not one of its name words, not inside its website's domain
 *      label, not its initials.
 * A filename with no naming word (`logo.png`, `logo-white-1024x512.png`) never
 * flags: there is nothing to compare.
 */
export function logoOtherOrgName(
  imageUrl: string,
  promoterName: string | null | undefined,
  website: string | null | undefined
): boolean {
  const segs = pathSegments(imageUrl);
  if (segs.length === 0) return false;
  if (segs.some((seg) => /sponsor|partner/.test(seg))) return true;

  const file = segs[segs.length - 1].replace(/\.[a-z0-9]+$/, "");
  if (!file.includes("logo")) return false;
  const naming = wordTokens(file).filter(
    (t) =>
      t.length >= 3 &&
      !LOGO_FILENAME_NOISE.has(t) &&
      !/^\d+$/.test(t) &&
      !/^\d+x\d+$/.test(t) &&
      // WordPress duplicate / crop suffixes: e1597412345678, v2.
      !/^e\d{6,}$/.test(t) &&
      !/^v\d+$/.test(t)
  );
  if (naming.length === 0) return false;

  const nameWords = wordTokens(promoterName ?? "").filter((t) => !NAME_STOPWORDS.has(t));
  const initials = nameWords.map((w) => w[0]).join("");
  const domainLabel = (hostOf(website) ?? "").split(".")[0] ?? "";

  const affine = (t: string) =>
    nameWords.includes(t) ||
    (domainLabel.length > 0 && (domainLabel.includes(t) || t.includes(domainLabel))) ||
    (initials.length >= 2 && t === initials) ||
    nameWords.some((w) => w.length >= 4 && (t.includes(w) || w.includes(t)));
  return !naming.some(affine);
}

/** Email domain equals (or is under) the promoter's website domain. */
export function emailOnOwnDomain(email: string, website: string | null | undefined): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  const site = hostOf(website);
  return !!domain && !!site && (sameOrSub(domain, site) || sameOrSub(site, domain));
}

export interface SanityProposal {
  field: string;
  proposedValue: string;
  method: string;
  flags: string[];
  autoApply: boolean;
  sourceUrl?: string;
}

export interface SanityContext {
  state: string | null | undefined;
  /** The promoter's company name (OPE-1714 logo_other_org_name). */
  name?: string | null;
  website: string | null | undefined;
  /** The URL the homepage fetch actually landed on (after redirects). */
  finalUrl?: string | null;
  /**
   * The homepage JSON-LD describes more than one business: more than one
   * distinct phone, or a named social account with no affinity to the promoter.
   */
  jsonLdMultipleEntities: boolean;
}

function addFlag(p: SanityProposal, flag: PromoterSanityFlag, blocksApply: boolean): void {
  if (!p.flags.includes(flag)) p.flags.push(flag);
  if (blocksApply) p.autoApply = false;
}

/**
 * Add the OPE-1706 flags to every proposal, in place. Run after the Contact
 * page hop, so a contact found there is checked too (hotline@ came from
 * /city/contact-connect).
 *
 * `jsonld_multiple_entities` applies only to contacts read FROM the JSON-LD
 * (`method === "jsonld"`) on the homepage. A JSON-LD email on the promoter's
 * own domain is exempt: the domain itself shows whose it is. That is the
 * Purity Spring case: `info@purityspring.com` sat in the same JSON-LD as the
 * wrong 605 phone and was correct.
 */
export function applyPromoterSanityFlags(proposals: SanityProposal[], ctx: SanityContext): void {
  for (const p of proposals) {
    if (p.field === "contact_phone") {
      if (phoneRegionMismatch(p.proposedValue, ctx.state)) {
        addFlag(p, "phone_region_mismatch", true);
      }
      if (ctx.jsonLdMultipleEntities && p.method === "jsonld" && !p.sourceUrl) {
        addFlag(p, "jsonld_multiple_entities", true);
      }
    } else if (p.field === "contact_email") {
      if (isRoleAddress(p.proposedValue)) addFlag(p, "email_role_address", true);
      if (
        ctx.jsonLdMultipleEntities &&
        p.method === "jsonld" &&
        !p.sourceUrl &&
        !emailOnOwnDomain(p.proposedValue, ctx.website)
      ) {
        addFlag(p, "jsonld_multiple_entities", true);
      }
    } else if (p.field === "logo") {
      if (logoOffsite(p.proposedValue, [ctx.website, ctx.finalUrl])) {
        addFlag(p, "logo_offsite", true);
      }
      if (logoStockPhoto(p.proposedValue)) addFlag(p, "logo_stock_photo", true);
      if (logoOtherOrgName(p.proposedValue, ctx.name, ctx.website)) {
        addFlag(p, "logo_other_org_name", true);
      }
      // The size half of logo_favicon is added where the probe measured it
      // (promoter-dispatch.ts buildProposals); this is the URL half.
      if (logoFavicon(p.proposedValue)) addFlag(p, "logo_favicon", true);
    }
  }
}
