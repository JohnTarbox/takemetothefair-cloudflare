/**
 * OPE-968 — how the image-from-URL fetchers identify themselves, and how they
 * describe a response that is not the image.
 *
 * Measured 2026-09-13 against the ticket's own failing URL (the Guilford Fair
 * 2026 poster, a WordPress upload):
 *
 *   Mozilla/5.0 (compatible; MMATFBot/1.0)                    403 text/html
 *   Mozilla/5.0 (compatible)                                  403 text/html
 *   MeetMeAtTheFair/1.0 (+https://meetmeatthefair.com)        200 image/png
 *   curl's default UA / a browser UA                          200 image/png
 *
 * The origin blocks the "Mozilla/5.0 (compatible; …)" shape — a common spoofed-
 * crawler signature — not us. The UA we used was chosen to "look plausible"
 * and was the thing being blocked. So we now say who we are, plainly, and fall
 * back to the old string only when a host answers the new one with a block,
 * because that string exists for hosts (the code comment named Facebook's CDN)
 * that wanted it. Neither impersonates a browser.
 *
 * And when a fetch still fails, the message describes what CAME BACK. Before,
 * a block page surfaced as `Unsupported content type "text/html"` — which
 * points the caller at the image, when the image was fine and the fetcher was
 * refused, and a repo-less lane recorded two good posters as unavailable.
 */

export const IMAGE_FETCH_USER_AGENT = "MeetMeAtTheFair/1.0 (+https://meetmeatthefair.com)";
export const LEGACY_IMAGE_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; MMATFBot/1.0)";
/** Tried in order; the next is used only after a BLOCKED verdict. */
export const IMAGE_FETCH_USER_AGENTS = [
  IMAGE_FETCH_USER_AGENT,
  LEGACY_IMAGE_FETCH_USER_AGENT,
] as const;

export const IMAGE_FETCH_ACCEPT =
  "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*;q=0.8,*/*;q=0.5";

export function imageFetchHeaders(userAgent: string): Record<string, string> {
  return { "User-Agent": userAgent, Accept: IMAGE_FETCH_ACCEPT };
}

/** Statuses a bot wall, WAF or rate limiter answers with. */
const BLOCK_STATUSES = new Set([200, 401, 403, 406, 429, 503]);

export type ImageFetchVerdict =
  | { kind: "image" }
  | { kind: "blocked"; message: string }
  | { kind: "http-error"; message: string }
  | { kind: "not-image"; message: string };

export interface ImageResponseFacts {
  status: number;
  /** Response URL after redirects (may equal the request URL). */
  finalUrl: string;
  contentType: string | null;
  /** First bytes of the body as text — read only when the response is not an image. */
  bodyHead?: string;
}

function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** Whether the body must be sniffed before deciding (it cannot be an image). */
export function needsBodyHead(status: number, contentType: string | null): boolean {
  const t = mediaType(contentType);
  return status < 200 || status >= 300 || t.startsWith("text/") || t === "application/xhtml+xml";
}

function looksLikeHtml(contentType: string | null, bodyHead: string | undefined): boolean {
  const t = mediaType(contentType);
  if (t === "text/html" || t === "application/xhtml+xml") return true;
  return /^\s*(<!doctype html|<html)/i.test(bodyHead ?? "");
}

function quote(bodyHead: string | undefined): string {
  const s = (bodyHead ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  return s ? ` Body starts: "${s}".` : "";
}

export function classifyImageResponse(f: ImageResponseFacts): ImageFetchVerdict {
  const t = mediaType(f.contentType) || "unknown";
  const where = ` Final URL: ${f.finalUrl}.`;
  if (looksLikeHtml(f.contentType, f.bodyHead) && BLOCK_STATUSES.has(f.status)) {
    return {
      kind: "blocked",
      message:
        `Fetch blocked by origin (HTTP ${f.status}, ${t} — likely bot protection or an interstitial). ` +
        `The image itself may be fine: it did not come back, a web page did.${where}${quote(f.bodyHead)}`,
    };
  }
  if (f.status < 200 || f.status >= 300) {
    return {
      kind: "http-error",
      message: `Source image fetch returned HTTP ${f.status} (${t}).${where}${quote(f.bodyHead)}`,
    };
  }
  if (t.startsWith("text/") || t === "application/xhtml+xml") {
    return {
      kind: "not-image",
      message: `Not an image: the URL returned ${t}.${where}${quote(f.bodyHead)}`,
    };
  }
  return { kind: "image" };
}

/**
 * Fetch an image URL with the honest UA, retrying once with the legacy UA when
 * (and only when) the first answer is a block. `doFetch` is injected so the
 * main app can keep its SSRF-guarded redirect walk.
 */
export async function fetchImageWithFallback(
  doFetch: (userAgent: string) => Promise<Response>
): Promise<
  | { ok: true; response: Response; userAgent: string; attempts: string[] }
  | { ok: false; verdict: Exclude<ImageFetchVerdict, { kind: "image" }>; attempts: string[] }
> {
  const attempts: string[] = [];
  let last: Exclude<ImageFetchVerdict, { kind: "image" }> | null = null;
  for (const ua of IMAGE_FETCH_USER_AGENTS) {
    const res = await doFetch(ua);
    const contentType = res.headers.get("Content-Type");
    const bodyHead = needsBodyHead(res.status, contentType)
      ? (await res.text().catch(() => "")).slice(0, 400)
      : undefined;
    const verdict = classifyImageResponse({
      status: res.status,
      finalUrl: res.url || "(unknown)",
      contentType,
      bodyHead,
    });
    attempts.push(`${ua} → HTTP ${res.status} ${mediaType(contentType) || "unknown"}`);
    if (verdict.kind === "image") return { ok: true, response: res, userAgent: ua, attempts };
    last = verdict;
    if (verdict.kind !== "blocked") break;
  }
  return { ok: false, verdict: last!, attempts };
}
