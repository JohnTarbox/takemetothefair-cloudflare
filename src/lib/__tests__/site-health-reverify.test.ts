/**
 * OPE-373 — re-verifying a health issue against the page as it stands today.
 *
 * The queue's only resolution path asked Google "do you still think this is
 * broken?", and a GSC verdict describes Google's LAST CRAWL. For the noindex
 * bucket that path can never clear the row: 110 open rows said "Excluded by
 * 'noindex'" about pages serving 200 with no noindex at all, four of them
 * re-detected the same day they were first raised.
 *
 * So these tests pin the thing that makes the queue answer "is it true NOW":
 * the origin is authoritative for what the origin can settle, and — just as
 * importantly — it is NOT consulted for anything it cannot.
 */
import { describe, it, expect } from "vitest";
import { reverifyHealthIssue, classifyMessage, assertsNoindex } from "../site-health-reverify";

const res = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });

const fetchReturning = (r: Response) => (async () => r) as unknown as typeof fetch;

describe("classifyMessage (OPE-373)", () => {
  it("matches GSC's curly apostrophe, which is what it actually emits", () => {
    // The live rows read "Excluded by ‘noindex’ tag" with U+2018/U+2019. A
    // naive straight-quote comparison matches zero rows in production and the
    // whole pass silently does nothing.
    expect(classifyMessage("Excluded by ‘noindex’ tag")).toBe("NOINDEX");
    expect(classifyMessage("Excluded by 'noindex' tag")).toBe("NOINDEX");
  });

  it("recognises the other locally-decidable classes", () => {
    expect(classifyMessage("Server error (5xx)")).toBe("SERVER_ERROR");
    expect(classifyMessage("Not found (404)")).toBe("NOT_FOUND");
  });

  it("refuses classes our origin cannot settle", () => {
    // A 200 from us says NOTHING about whether Google chose to index the page.
    // Claiming to verify these locally would be the same error inverted.
    expect(classifyMessage("Crawled - currently not indexed")).toBeNull();
    expect(classifyMessage("Discovered - currently not indexed")).toBeNull();
    expect(classifyMessage("URL is unknown to Google")).toBeNull();
    expect(classifyMessage("Page with redirect")).toBeNull();
    expect(classifyMessage(null)).toBeNull();
  });
});

describe("assertsNoindex (OPE-373)", () => {
  it("does not fire on the word appearing in prose or inlined JS", () => {
    // A bare substring search over the document is the obvious implementation
    // and it is wrong — it would resolve nothing and quietly keep every row open.
    const html = `<html><body><p>We never set noindex on vendor pages.</p>
      <script>const noindex = false;</script></body></html>`;
    expect(assertsNoindex(html, null)).toBe(false);
  });

  it("fires on a real robots meta", () => {
    expect(assertsNoindex(`<meta name="robots" content="noindex, nofollow">`, null)).toBe(true);
  });

  it("fires on the googlebot-specific meta", () => {
    expect(assertsNoindex(`<meta name="googlebot" content="noindex">`, null)).toBe(true);
  });

  it("fires on the X-Robots-Tag header alone", () => {
    // Header-only noindex is invisible in the markup. Checking one channel
    // would miss it entirely and wrongly report the page indexable.
    expect(assertsNoindex("<html></html>", "noindex")).toBe(true);
  });

  it("is not fooled by an index directive containing the substring", () => {
    expect(assertsNoindex(`<meta name="robots" content="index, follow">`, null)).toBe(false);
  });
});

describe("reverifyHealthIssue (OPE-373)", () => {
  it("clears a noindex row when the live page has no directive", async () => {
    // The exact production case: /vendors/garmin-international et al — HTTP
    // 200, zero noindex, and Google still saying otherwise from a stale crawl.
    const outcome = await reverifyHealthIssue(
      "https://meetmeatthefair.com/vendors/garmin-international",
      "Excluded by ‘noindex’ tag",
      { fetchImpl: fetchReturning(res("<html><body>Garmin</body></html>")) }
    );
    expect(outcome).toEqual({
      decidable: true,
      stillFailing: false,
      detail: "HTTP 200, no noindex directive",
    });
  });

  it("keeps a noindex row open when the page really is noindex", async () => {
    const outcome = await reverifyHealthIssue(
      "https://meetmeatthefair.com/vendors/mention-tier",
      "Excluded by ‘noindex’ tag",
      {
        fetchImpl: fetchReturning(res(`<meta name="robots" content="noindex">`)),
      }
    );
    expect(outcome).toMatchObject({ decidable: true, stillFailing: true });
  });

  it("clears a 5xx row once the page serves 200", async () => {
    const outcome = await reverifyHealthIssue(
      "https://meetmeatthefair.com/blog/vermont-maple-products-at-fairs",
      "Server error (5xx)",
      { fetchImpl: fetchReturning(res("ok")) }
    );
    expect(outcome).toMatchObject({ decidable: true, stillFailing: false, detail: "HTTP 200" });
  });

  it("keeps a 5xx row open while it is still 5xx", async () => {
    const outcome = await reverifyHealthIssue("https://x/y", "Server error (5xx)", {
      fetchImpl: fetchReturning(res("boom", { status: 503 })),
    });
    expect(outcome).toMatchObject({ decidable: true, stillFailing: true });
  });

  it("treats a failed fetch as undecidable, NOT as fixed", async () => {
    // The dangerous default. A network blip must never close a row — that is
    // exactly how a real outage gets recorded as a recovery.
    const outcome = await reverifyHealthIssue("https://x/y", "Server error (5xx)", {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(outcome.decidable).toBe(false);
  });

  it("will not judge noindex from a non-200 response", async () => {
    // A 301/404 tells us nothing about the robots directive of a page we did
    // not receive. Guessing here would close rows on no evidence.
    const outcome = await reverifyHealthIssue("https://x/y", "Excluded by ‘noindex’ tag", {
      fetchImpl: fetchReturning(res("", { status: 301 })),
    });
    expect(outcome.decidable).toBe(false);
  });

  it("never touches a class the origin cannot settle", async () => {
    let called = false;
    const outcome = await reverifyHealthIssue("https://x/y", "Crawled - currently not indexed", {
      fetchImpl: (async () => {
        called = true;
        return res("");
      }) as unknown as typeof fetch,
    });
    expect(outcome.decidable).toBe(false);
    // And it does not even spend the request.
    expect(called).toBe(false);
  });
});
