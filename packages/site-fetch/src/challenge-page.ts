/**
 * Bot-challenge / interstitial detection.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * OPE-537, third failure shape. A bare-URL submission for
 * `https://10times.com/e1sk-x49s-29xr` (inbound `71853429`, 2026-08-24)
 * produced a PENDING event:
 *
 *     name         "Just a moment..."
 *     description  "Just a moment... - suggested by the community"
 *     start/end    NULL
 *
 * The origin serves a Cloudflare challenge (`cf-mitigated: challenge`,
 * `<title>Just a moment...</title>`). The standard fetch got 403, escalated
 * to Browser Rendering as designed, and Browser Rendering rendered the
 * CHALLENGE PAGE and returned it as a successful 200. Everything downstream
 * behaved correctly on the document it was given — the document was just not
 * the event.
 *
 * ── Why the existing guards miss it ──────────────────────────────────────
 * The ladder built earlier in this ticket tests whether we got BYTES:
 *
 *     PR #1018  did the fetch FAIL?     -> a challenge answers 200, so no
 *     PR #1017  is the text EMPTY?      -> a challenge is ~5.6KB, so no
 *
 * Neither asks whether the bytes are the document we requested. A challenge
 * page is a successful fetch of the wrong page, and that is its own rung.
 *
 * ── Detection posture ────────────────────────────────────────────────────
 * These markers are vendor boilerplate, not prose an event page would carry,
 * so false positives are unlikely — but the cost asymmetry still runs one
 * way: a false positive is a bounce the sender can retry or paste around; a
 * false negative publishes "Just a moment..." as the name of somebody's fair.
 */

/** `cf-mitigated` values that mean the response body is an interstitial. */
const MITIGATED_HEADER = "cf-mitigated";

/**
 * Markers that identify an interstitial body.
 *
 * Kept to vendor-specific strings and exact challenge titles. Deliberately
 * NOT included: bare phrases like "access denied" or "are you a robot",
 * which appear in legitimate copy (a fair's FAQ about photography policy,
 * a CAPTCHA-themed event) and would misfire.
 */
const BODY_MARKERS: Array<{ re: RegExp; vendor: string }> = [
  // Cloudflare Managed Challenge / "Under Attack" interstitial.
  { re: /<title>\s*Just a moment\.\.\.\s*<\/title>/i, vendor: "cloudflare" },
  { re: /cdn-cgi\/challenge-platform/i, vendor: "cloudflare" },
  { re: /Enable JavaScript and cookies to continue/i, vendor: "cloudflare" },
  { re: /<title>\s*Attention Required!\s*\|\s*Cloudflare\s*<\/title>/i, vendor: "cloudflare" },
  // Other common WAF vendors, same failure shape.
  { re: /<title>\s*Access to this page has been denied\s*<\/title>/i, vendor: "perimeterx" },
  { re: /_px(?:Captcha|AppId)\b/, vendor: "perimeterx" },
  { re: /\bdatadome\b[^<]{0,80}captcha/i, vendor: "datadome" },
  { re: /Request unsuccessful\. Incapsula incident ID/i, vendor: "imperva" },
  { re: /<title>\s*Pardon Our Interruption\s*<\/title>/i, vendor: "distil" },
  { re: /\bak(?:am)?_?bmsc\b|\/_sec\/cp_challenge\//i, vendor: "akamai" },
];

export interface ChallengeVerdict {
  /** True when the body is an interstitial rather than the requested page. */
  isChallenge: boolean;
  /** Which vendor's interstitial, for the log. Null when not a challenge. */
  vendor: string | null;
  /** Which signal fired — "header" or the matched body pattern's vendor. */
  signal: string | null;
}

const NOT_A_CHALLENGE: ChallengeVerdict = { isChallenge: false, vendor: null, signal: null };

/**
 * Classify a fetched document as a bot interstitial or as real content.
 *
 * `headers` is optional because the Browser Rendering path never exposes the
 * origin's headers — it returns rendered HTML only. That path therefore
 * depends entirely on the body markers, which is exactly the case that
 * produced "Just a moment..." as an event name.
 *
 * Only the first 64KB is scanned: challenge pages are small and put their
 * markers in `<head>`, while a real event page can be megabytes, and a
 * regex sweep over all of it on every fetch is waste.
 */
export function detectChallengePage(
  html: string | null | undefined,
  headers?: Headers | null
): ChallengeVerdict {
  const mitigated = headers?.get(MITIGATED_HEADER);
  if (mitigated && mitigated.trim().toLowerCase() === "challenge") {
    return { isChallenge: true, vendor: "cloudflare", signal: "header" };
  }
  if (typeof html !== "string" || html === "") return NOT_A_CHALLENGE;
  const head = html.length > 65536 ? html.slice(0, 65536) : html;
  for (const { re, vendor } of BODY_MARKERS) {
    if (re.test(head)) return { isChallenge: true, vendor, signal: vendor };
  }
  return NOT_A_CHALLENGE;
}

/** Convenience predicate for call sites that do not need the vendor. */
export function isChallengePage(
  html: string | null | undefined,
  headers?: Headers | null
): boolean {
  return detectChallengePage(html, headers).isChallenge;
}

/**
 * The message a submitter sees. Says what happened and what to do, without
 * blaming them or implying the URL was wrong — the URL is usually fine and
 * loads perfectly in their own browser, which is precisely why an unexplained
 * failure here reads as us being broken.
 */
export const CHALLENGE_USER_MESSAGE =
  "That page is behind a bot-protection check we can't pass automatically. " +
  "Please reply with the event details pasted as text (dates, venue, hours, fees), " +
  "or send a link to another page for the same event.";
