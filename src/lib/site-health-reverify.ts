/**
 * OPE-373 — re-verify a health issue against the page as it stands today.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 * The queue's only resolution path was "re-inspect the URL and see whether
 * Google now says PASS". For most verdicts that is fine. For two classes it is
 * structurally incapable of ever clearing the row, because a GSC verdict
 * describes GOOGLE'S LAST CRAWL, not the page as it currently exists.
 *
 * Measured 2026-08-11: 110 open rows read "Excluded by 'noindex' tag", 98 of
 * them `/vendors/*`. Fetched as Googlebot, they return HTTP 200 with zero
 * occurrences of `noindex` and a self-referential canonical. They were imported
 * at MENTION tier (correctly noindex'd), later enriched into STANDARD tier, and
 * Google has not re-crawled. Four of them carry `first_detected_at =
 * last_detected_at = 2026-08-11` — the sweep re-detected them TODAY. Asking
 * Google again tomorrow returns the same stale answer, forever.
 *
 * So for the classes where OUR SERVER is the authority, we ask our server.
 *
 * ── Why this must feed suppression, not just cleanup ────────────────────────
 * Resolving these rows without also suppressing them re-creates them on the
 * next sweep: `runSweep` re-opens a resolved row whenever the next inspection
 * comes back non-PASS. So the result feeds `effectivelyPassing`, extending the
 * concept `isRedirectToIndexed()` already established — "GSC says non-PASS, and
 * we have better information". Same lesson as OPE-372: resolve without prevent
 * and the queue simply refills.
 *
 * ── Deliberately narrow ─────────────────────────────────────────────────────
 * Only classes where a local fetch is DECISIVE are checked. "Crawled –
 * currently not indexed", "Discovered – currently not indexed" and "URL is
 * unknown to Google" are facts about Google's index that our origin cannot
 * contradict: a 200 from us says nothing about whether Google chose to index
 * it. Those stay with GSC (and with the staleness expiry). Claiming to verify
 * them locally would be the same error in the opposite direction.
 */

/** GSC coverage-state strings we can decide locally. Matched case-insensitively
 *  and on a normalised quote, because GSC emits a curly apostrophe. */
const LOCALLY_DECIDABLE = {
  NOINDEX: "excluded by 'noindex' tag",
  SERVER_ERROR: "server error (5xx)",
  NOT_FOUND: "not found (404)",
} as const;

export type ReverifyOutcome =
  /** Local truth contradicts the recorded issue — it is genuinely gone. */
  | { decidable: true; stillFailing: false; detail: string }
  /** Local truth confirms the issue still holds. */
  | { decidable: true; stillFailing: true; detail: string }
  /** Not a class our origin can settle, or the check itself failed. */
  | { decidable: false; detail: string };

/** Normalise GSC's curly apostrophes so message matching is not quote-fragile. */
function normalizeMessage(message: string | null): string {
  return (message ?? "")
    .toLowerCase()
    .replace(/[‘’‛ʼ]/g, "'")
    .trim();
}

/** Which locally-decidable class is this, if any? */
export function classifyMessage(message: string | null): keyof typeof LOCALLY_DECIDABLE | null {
  const m = normalizeMessage(message);
  if (m.includes(LOCALLY_DECIDABLE.NOINDEX)) return "NOINDEX";
  if (m.includes(LOCALLY_DECIDABLE.SERVER_ERROR)) return "SERVER_ERROR";
  if (m.includes(LOCALLY_DECIDABLE.NOT_FOUND)) return "NOT_FOUND";
  return null;
}

/**
 * Does this response actually assert noindex?
 *
 * Checks BOTH channels, because either is sufficient to deindex a page and
 * checking only the HTML would miss a header-level directive:
 *   - `X-Robots-Tag` response header
 *   - `<meta name="robots" ...>` / `<meta name="googlebot" ...>` in the markup
 *
 * A bare substring search for "noindex" over the whole document would be wrong
 * — the word appears in our own prose and in inlined JS — so the meta check is
 * anchored to an actual robots meta tag.
 */
export function assertsNoindex(html: string, xRobotsTag: string | null): boolean {
  if (xRobotsTag && /\bnoindex\b/i.test(xRobotsTag)) return true;
  const metaRobots = html.matchAll(
    /<meta[^>]+name=["']?(?:robots|googlebot)["']?[^>]*content=["']([^"']*)["'][^>]*>/gi
  );
  for (const m of metaRobots) {
    if (/\bnoindex\b/i.test(m[1])) return true;
  }
  return false;
}

export interface ReverifyDeps {
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the URL and decide whether the recorded condition still holds.
 *
 * Fetched as Googlebot: our tier gating can vary the emitted robots meta by
 * user-agent, and the question being answered is "what does Google see", so
 * asking as anyone else would verify the wrong thing.
 */
export async function reverifyHealthIssue(
  url: string,
  message: string | null,
  deps: ReverifyDeps = {}
): Promise<ReverifyOutcome> {
  const kind = classifyMessage(message);
  if (!kind) {
    return { decidable: false, detail: `not locally decidable: ${message ?? "(null)"}` };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
      redirect: "manual",
    });
  } catch (error) {
    // A failed check is NOT evidence the problem is gone. Leave the row open.
    return {
      decidable: false,
      detail: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const status = response.status;

  if (kind === "SERVER_ERROR") {
    const stillFailing = status >= 500;
    return { decidable: true, stillFailing, detail: `HTTP ${status}` };
  }

  if (kind === "NOT_FOUND") {
    const stillFailing = status === 404 || status === 410;
    return { decidable: true, stillFailing, detail: `HTTP ${status}` };
  }

  // NOINDEX — only a 200 lets us speak. A 3xx/4xx/5xx means the page is not
  // serving normally, which is a different problem and not ours to close here.
  if (status !== 200) {
    return { decidable: false, detail: `HTTP ${status} — cannot assess noindex` };
  }
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    return {
      decidable: false,
      detail: `body read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const stillFailing = assertsNoindex(html, response.headers.get("x-robots-tag"));
  return {
    decidable: true,
    stillFailing,
    detail: stillFailing ? "page asserts noindex" : "HTTP 200, no noindex directive",
  };
}
