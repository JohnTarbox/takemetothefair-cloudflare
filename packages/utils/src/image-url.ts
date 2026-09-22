/**
 * OPE-1112 — is this string plausibly a link to an IMAGE?
 *
 * Distinct from `classifyImageHost`, which answers "who serves it". A
 * hotlinked Shopify logo and a Facebook page URL are both `third_party`; only
 * one of them is an image.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `vendors.logo_url` accepted any string. A maker claimed her listing, found a
 * field labelled "Logo URL" with a `https://…` placeholder and no way to
 * upload a file, and pasted the only URL she owned — her Facebook page. It
 * stored clean and rendered as nothing, and she reported it as "the photo
 * wouldn't show".
 *
 * That is not misuse. It is the predictable result of asking a non-technical
 * seller for a hosted image URL. Measured on prod 2026-09-22, every one of the
 * 8 genuinely-broken values belonged to a CLAIMED vendor — a real person who
 * typed it in. Nobody scraped these; the field taught people to do it.
 *
 * ── Why the rule is strict ────────────────────────────────────────────────
 *
 * Strictness is only fair because OPE-1112 also ships a file upload. Rejecting
 * a URL used to leave a vendor with no way to set a logo at all; now the error
 * can point at a button that works. A rule that rejects a valid-but-exotic CDN
 * URL costs that vendor one upload. A rule that accepts page URLs costs every
 * visitor a broken image and the vendor their brand.
 *
 * ── The trap this encodes ─────────────────────────────────────────────────
 *
 * The obvious rule — "ends with .jpg" — is WRONG, and the prod data proves it:
 * 6 of the 14 values my first crude sweep flagged were real images carrying a
 * cache-buster (`…/Black_logo_1_140x.png?v=1720552338`). The extension test
 * must run against the PATH, never the whole URL.
 */

/** Extensions we will accept in a URL path. */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"];

/**
 * Hosts that serve images from paths with no extension.
 *
 * Suffix-matched against the hostname, so `cdn.shopify.com` also covers
 * `foo.cdn.shopify.com`. Kept short on purpose: every entry is a host we have
 * actually seen serving a vendor logo in prod, not a guess at what might work.
 */
const IMAGE_CDN_HOST_SUFFIXES = [
  "cdn.meetmeatthefair.com",
  "cdn.shopify.com",
  "cdninstagram.com",
  "fbcdn.net",
  "squarespace-cdn.com",
  "wixstatic.com",
  "googleusercontent.com",
  "imgur.com",
  "cloudinary.com",
  "unsplash.com",
];

/**
 * Host + path shapes that are pages, not images.
 *
 * Checked BEFORE the extension test, because a page URL can still end in
 * something that looks like an extension, and because the resulting error
 * message should name what the vendor actually pasted rather than say
 * "no image extension" about a Facebook link.
 */
const KNOWN_PAGE_PATTERNS: ReadonlyArray<{ test: (u: URL) => boolean; what: string }> = [
  { test: (u) => u.hostname.endsWith("facebook.com"), what: "a Facebook page" },
  {
    // instagram.com/<handle> is a profile; *.cdninstagram.com is the image host
    // and is handled by the CDN list above.
    test: (u) => u.hostname.endsWith("instagram.com") && !u.hostname.includes("cdn"),
    what: "an Instagram profile",
  },
  { test: (u) => u.hostname.endsWith("linktr.ee"), what: "a Linktree page" },
  { test: (u) => u.hostname.endsWith("etsy.com"), what: "an Etsy shop page" },
  { test: (u) => u.pathname.includes("/profile.php"), what: "a profile page" },
  { test: (u) => u.pathname.startsWith("/author/"), what: "an author page" },
  {
    // share.icloud.com/photos/<token> is a viewer page, not a direct image.
    test: (u) => u.hostname.endsWith("icloud.com"),
    what: "an iCloud sharing page",
  },
];

export interface ImageUrlVerdict {
  ok: boolean;
  /** Vendor-facing explanation. Empty when ok. */
  reason: string;
}

/**
 * Validate a user-supplied image URL.
 *
 * Empty/nullish is OK — "no logo" is a legitimate state, and clearing the
 * field must stay possible. Callers wanting a required image check for
 * emptiness themselves.
 */
export function checkImageUrl(raw: string | null | undefined): ImageUrlVerdict {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true, reason: "" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      reason: "That doesn't look like a web address. It should start with https://",
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Use an https:// address." };
  }

  const host = url.hostname.toLowerCase();

  for (const pattern of KNOWN_PAGE_PATTERNS) {
    if (pattern.test(url)) {
      return {
        ok: false,
        reason: `That link points to ${pattern.what}, not an image file. Upload your logo instead, or paste a link that ends in .jpg or .png.`,
      };
    }
  }

  if (IMAGE_CDN_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return { ok: true, reason: "" };
  }

  // The extension test runs on the PATH. Running it on the whole URL would
  // reject every cache-busted logo — 6 real ones in prod on 2026-09-22.
  const path = url.pathname.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return { ok: true, reason: "" };
  }

  return {
    ok: false,
    reason:
      "That link doesn't point to an image file. Upload your logo instead, or paste a link that ends in .jpg, .png or .webp.",
  };
}

// NOTE: there is deliberately no `isPlausibleImageUrl(url): boolean` helper.
// One was written and deleted the same hour, because the OPE-726 inert-detector
// guard correctly refused it: every production caller wants the REASON, so the
// boolean had no caller outside its own tests. An exported predicate nothing
// calls is the same defect as a table nothing reads — see this ticket's sibling,
// OPE-1111. Call `checkImageUrl(...).ok` if you only need the verdict.
