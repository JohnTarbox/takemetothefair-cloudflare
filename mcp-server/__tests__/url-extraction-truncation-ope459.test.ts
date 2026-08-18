/**
 * OPE-459 — one truncated string, reported as two separate defects.
 *
 * Email "MV 1" (submit@, 2026-08-17T23:51:46Z) carried nine links in prose. The
 * ticket filed two findings:
 *
 *   1. `https://gomarthasvineyard.com/events-calendar` was fetched as
 *      `https://go/` — suspected "a regex alternation treating `go` as a token
 *      boundary", possibly from the OPE-193/OPE-277 short-link handling.
 *   2. a "silent cap at the first 5 URLs" dropped the four best sources
 *      (two `calendar.vineyardgazette.com` single-event pages among them).
 *
 * Both are the same line. The workflow read `bodyTextExcerpt` — a **500-char
 * admin preview** — instead of `bodyText`, the real body the handler already
 * stores at up to 50k. The stored excerpt for that email is exactly 500
 * characters and ends `…5\n<https://go`.
 *
 * So the 5th URL was cut mid-host, and `new URL("https://go")` parses that
 * perfectly happily as host `go`. The remaining four were simply past character
 * 500. There is no `go`-prefix regex, and no cap at 5 — `extractAllUrls` is
 * called with cap 10.
 */
import { describe, expect, it } from "vitest";
import { extractAllUrls, pickPrimaryUrl } from "../src/email-handler.js";

/** The body's first citation group, as sent. */
const MV1_BODY =
  "Explore craft fairs and festivals on Martha's Vineyard through events like " +
  "the weekly Vineyard Artisans Festivals at the Grange Hall in West Tisbury " +
  "(Thursdays and Sundays through summer), the Martha's Vineyard Agricultural " +
  "Fair in August, and seasonal holiday markets. [1 " +
  "<https://vineyardartisans.com/>, 2 " +
  "<https://www.mvvacationrentals.com/vineyard-activities/fairs-and-markets>, 3 " +
  "<https://www.facebook.com/vineyardartisans/>, 4 " +
  "<https://www.marthasvisit.com/summer-events>, 5 " +
  "<https://gomarthasvineyard.com/events-calendar>] " +
  "Also: <https://calendar.vineyardgazette.com/event/vineyard-artisans-summer-festival> " +
  "and <https://www.fiestashows.com/fs/vineyard-fair/>";

describe("the truncation that produced https://go/", () => {
  it("rejects a URL cut off mid-host", () => {
    // This is literally what sat at the end of the 500-char excerpt.
    expect(extractAllUrls("see 5\n<https://go", "", 10)).toEqual([]);
  });

  it("keeps the same host when it is NOT truncated", () => {
    const urls = extractAllUrls("<https://gomarthasvineyard.com/events-calendar>", "", 10);
    expect(urls).toEqual(["https://gomarthasvineyard.com/events-calendar"]);
  });

  it("proves there is no `go`-prefix mangling", () => {
    // The ticket suspected short-link handling was rewriting go-prefixed hosts.
    // Several go* hosts survive intact, so the prefix was never the problem.
    const urls = extractAllUrls(
      "https://gofundme.com/x https://google.com/y https://gomaine.org/z",
      "",
      10
    );
    expect(urls).toEqual([
      "https://gofundme.com/x",
      "https://google.com/y",
      "https://gomaine.org/z",
    ]);
  });

  it("rejects other dotless hosts too", () => {
    for (const u of ["https://localhost/x", "http://intranet/y", "https://go"]) {
      expect(extractAllUrls(u, "", 10)).toEqual([]);
    }
  });

  it("applies the same guard to pickPrimaryUrl", () => {
    expect(pickPrimaryUrl("mail me at https://go", "")).toBeNull();
  });
});

describe("there was never a cap at 5", () => {
  it("returns all seven links from the MV 1 body when given the full text", () => {
    const urls = extractAllUrls(MV1_BODY, "", 10);
    expect(urls.length).toBe(7);
    // The two the ticket called the highest-value sources, previously unseen.
    expect(urls).toContain(
      "https://calendar.vineyardgazette.com/event/vineyard-artisans-summer-festival"
    );
    expect(urls).toContain("https://www.fiestashows.com/fs/vineyard-fair/");
    // And the one that used to arrive as https://go/
    expect(urls).toContain("https://gomarthasvineyard.com/events-calendar");
  });

  it("loses the tail when handed only the first 500 characters", () => {
    // The regression, reproduced: this is what the workflow used to pass in.
    const excerpt = MV1_BODY.slice(0, 500);
    const fromExcerpt = extractAllUrls(excerpt, "", 10);
    const fromFull = extractAllUrls(MV1_BODY, "", 10);
    expect(fromExcerpt.length).toBeLessThan(fromFull.length);
    expect(fromExcerpt).not.toContain("https://gomarthasvineyard.com/events-calendar");
  });

  it("still honours an explicit cap when one is asked for", () => {
    expect(extractAllUrls(MV1_BODY, "", 3)).toHaveLength(3);
  });
});
