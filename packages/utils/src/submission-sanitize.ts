/**
 * OPE-411 — ingest-time sanity checks for user-supplied event submissions.
 *
 * One community submission (2026-08-04) arrived with four field-mapping defects
 * at once. The worst by far: the `name` field held the string **"Facebook"** —
 * the submitter typed the platform they found the event on — and nothing
 * questioned it. That minted the slug `/event/facebook`. It was caught only
 * because it landed in PENDING and a human happened to look; an auto-approving
 * path would have published it.
 *
 * These live in the shared package rather than in either ingest route because
 * there are TWO paths that create events from user submissions — the main app's
 * `/api/suggest-event/submit` and the MCP `suggest_event` tool — and a check
 * wired into one of two parallel paths is a check that gets bypassed. The rules
 * are pure functions so both callers apply the same judgement.
 */

/**
 * Strings that are never an event name. A submitter reaching for "where did I
 * find this?" or "I don't know" produces one of these.
 *
 * Deliberately EXACT matches on the trimmed, lowercased value, not substrings:
 * "Facebook" is junk, "Facebook Marketplace Craft Fair" is a real event name and
 * must pass. A substring rule would eat it.
 */
const PLATFORM_NAME_TOKENS = new Set([
  "facebook",
  "fb",
  "instagram",
  "ig",
  "eventbrite",
  "google",
  "craigslist",
  "twitter",
  "x",
  "tiktok",
  "website",
  "web site",
  "site",
  "link",
  "url",
  "email",
  "e-mail",
  "flyer",
  "poster",
  "event",
  "events",
  "n/a",
  "na",
  "none",
  "unknown",
  "test",
  "tbd",
  "tba",
  "-",
  "?",
]);

/** Hosts that mean "I left the placeholder in". */
const PLACEHOLDER_URL_HOSTS = new Set([
  "example.com",
  "www.example.com",
  "example.org",
  "example.net",
  "localhost",
  "test.com",
  "yourdomain.com",
  "domain.com",
]);

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".svg", ".bmp"];

/**
 * True when this value cannot be an event name: a known platform token, a bare
 * URL or hostname, or too short to identify anything.
 *
 * The length floor is 3, not something larger: real short names exist ("4-H
 * Fair" is 9, but abbreviations do occur), and the token list already catches
 * the specific short junk we have actually seen. A blunt "must be 10+ chars"
 * rule would reject real submissions to catch a case the exact-match set
 * already handles.
 */
export function isUnusableEventName(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  if (value.length < 3) return true;
  const lower = value.toLowerCase();
  if (PLATFORM_NAME_TOKENS.has(lower)) return true;
  // A bare URL or hostname submitted as the name: "facebook.com/groups/123",
  // "https://…", "www.something.org". The submitter pasted the link into the
  // wrong box.
  if (/^(https?:\/\/|www\.)/i.test(value)) return true;
  if (/^[a-z0-9-]+(\.[a-z]{2,})+(\/\S*)?$/i.test(value)) return true;
  return false;
}

/**
 * Hostname fragments that mark an asset/image CDN. Checked as a prefix on the
 * first label plus a couple of whole-host cases, NOT as a bare substring —
 * "cdn" appearing anywhere in a hostname is too loose.
 */
const IMAGE_HOST_PREFIXES = ["cdn", "img", "images", "static", "media", "assets", "photos"];
const IMAGE_HOSTS = new Set([
  "cdn.meetmeatthefair.com",
  "imagedelivery.net",
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
  "i.imgur.com",
]);

/**
 * True when a URL is plausibly an image we can render.
 *
 * ⚠️ **An extension-only rule is wrong, and the prod data is what proved it.**
 * The first draft of this function accepted only image file extensions. Checked
 * against the four rows the OPE-411 ticket flagged as "non-image values in
 * image_url", it would have rejected two REAL images:
 *
 *   cdn-az.allevents.in/events1/banners/7afed…-rimg-w934-h1169-…?v=1779535098
 *   lh3.googleusercontent.com/qFibo4OVSmcs…=w1200-h630-p
 *
 * Both are ordinary image-CDN URLs that carry no extension — the modern norm.
 * The ticket's count of 4 came from a `LIKE '%.jpg'`-style query and is really
 * **1** (the Square site root); the other three are fine, two of them only
 * because the extension sits before a query string.
 *
 * So the rule is: an image extension in the PATH (query ignored — `?format=1500w`
 * is not part of the filename), or our own delivery hosts, or a hostname that
 * announces itself as an asset CDN with an actual path on it. A bare site root
 * like `https://crafters-choice-llc.square.site/` — the value that produced this
 * ticket — fails all three.
 *
 * No content-type probe: it would add a network round-trip to every submission
 * and still cannot run during a backfill of rows whose remote hosts may be gone.
 */
export function isLikelyImageUrl(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  if (IMAGE_HOSTS.has(host)) return true;
  if (path.startsWith("/cdn-cgi/image/")) return true;
  // Prefix on the FIRST label only: `static1.squarespace.com` and
  // `cdn-az.allevents.in` match; `mystaticsite.com` does not, because the
  // fragment has to start the label rather than appear anywhere in the host.
  const firstLabel = host.split(".")[0] ?? "";
  const looksLikeAssetHost = IMAGE_HOST_PREFIXES.some((p) => firstLabel.startsWith(p));
  // A CDN host still needs a path — `https://cdn.example.com/` alone is not an
  // image any more than a site root is.
  return looksLikeAssetHost && path.length > 1;
}

/** True for a placeholder URL that should never be stored — `example.com`,
 *  `localhost`, a bare `#`, or anything unparseable. */
export function isPlaceholderUrl(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  if (!value) return false; // empty is "absent", handled by the caller
  if (value === "#" || value === "/" || value.toLowerCase() === "n/a") return true;
  try {
    const url = new URL(value);
    if (PLACEHOLDER_URL_HOSTS.has(url.hostname.toLowerCase())) return true;
    if (url.hostname.endsWith(".example.com")) return true;
    return false;
  } catch {
    // Not a URL at all — a bare word in a URL field is not a URL we should keep.
    return true;
  }
}

/**
 * Strip the trailing `\n\nLocation: …` block this codebase's own submit route
 * appends when it has venue fields.
 *
 * That block is not the submitter's prose — `/api/suggest-event/submit` writes
 * it as a fallback so the location text is not lost when `autoLinkVenue`
 * declines to match. It is worth keeping ONLY in that case: once a venue is
 * linked, the same address is on the venue record and the tail is duplicated
 * text sitting in the public description, where it also pollutes the search
 * index and the meta description.
 *
 * Returns the description unchanged when there is no such block.
 */
export function stripLocationTail(description: string | null | undefined): string | null {
  const value = description ?? null;
  if (value === null) return null;
  const idx = value.lastIndexOf("\n\nLocation: ");
  if (idx === -1) return value;
  const trimmed = value.slice(0, idx).trimEnd();
  // Never return an empty description by stripping — a row whose entire body
  // was the location block is better off keeping it than showing nothing.
  return trimmed.length > 0 ? trimmed : value;
}
