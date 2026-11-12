/**
 * OPE-491 rework → OPE-1642 — editing a row's source must not rewrite how the
 * row was collected. `ingestion_method` is written once, at insert; an edit
 * refreshes `source_domain` and fills a BLANK method, never overwrites one.
 *
 * Specimens:
 *  - 13f7f7a4 (Revolutionary Fair, `email_submission`): a repair pointing
 *    `source_url` at the organizer's Facebook page flipped it to `direct_scrape`.
 *  - 3b7ddadb (Pine State Expo 2027, `web_research`): `source_name="facebook"`
 *    relabeled it `community_suggestion`, because a recognised label used to win.
 */
import { describe, expect, it } from "vitest";
import { classifySource, reclassifySourceOnEdit } from "./source-classification";

const FB = "https://www.facebook.com/revolutionaryfair";

describe("reclassifySourceOnEdit (write-once)", () => {
  it("keeps email_submission when only a citation URL is added (the 13f7f7a4 specimen)", () => {
    const r = reclassifySourceOnEdit({
      currentMethod: "email_submission",
      sourceName: "Revolutionary Fair Facebook page",
      sourceUrl: FB,
    });
    // Landmark: the naive recompute really would have flipped it.
    expect(classifySource("Revolutionary Fair Facebook page", FB).ingestionMethod).toBe(
      "direct_scrape"
    );
    expect(r).toMatchObject({ ingestionMethod: "email_submission", preservedMethod: true });
    // The domain still refreshes — it IS a property of the URL.
    expect(r.sourceDomain).toBe("facebook.com");
  });

  it("a recognised LABEL no longer wins: source_name='facebook' keeps web_research (the 3b7ddadb specimen)", () => {
    const url = "https://www.facebook.com/pinestateexpo/";
    // Landmark: the label really does map to a different method.
    expect(classifySource("facebook", url).ingestionMethod).toBe("community_suggestion");
    const r = reclassifySourceOnEdit({
      currentMethod: "web_research",
      sourceName: "facebook",
      sourceUrl: url,
    });
    expect(r).toMatchObject({
      ingestionMethod: "web_research",
      preservedMethod: true,
      sourceDomain: "facebook.com",
    });
  });

  it.each([
    "vendor_submission",
    "community_suggestion",
    "web_research",
    "discovery",
    "direct_scrape",
    "aggregator_import",
    "admin_manual",
  ])("keeps %s against any source edit, label or URL", (m) => {
    for (const sourceName of [null, "daily-discovery", "eventbrite"]) {
      expect(
        reclassifySourceOnEdit({
          currentMethod: m,
          sourceName,
          sourceUrl: "https://organizer.example/fair",
        }).ingestionMethod
      ).toBe(m);
    }
  });

  it("a NULL or unknown current value is FILLED from the new source (a blank, not an overwrite)", () => {
    expect(
      reclassifySourceOnEdit({ currentMethod: null, sourceName: null, sourceUrl: FB })
    ).toMatchObject({ ingestionMethod: "direct_scrape", preservedMethod: false });
    expect(
      reclassifySourceOnEdit({ currentMethod: "bogus", sourceName: null, sourceUrl: FB })
        .ingestionMethod
    ).toBe("direct_scrape");
  });
});
