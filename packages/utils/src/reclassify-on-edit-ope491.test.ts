/**
 * OPE-491 rework — editing a citation URL must not rewrite how a row was
 * collected. Specimen: event 13f7f7a4 (Revolutionary Fair) came in through
 * submit@ as `email_submission`; a repair that pointed `source_url` at the
 * organizer's Facebook page flipped it to `direct_scrape`.
 */
import { describe, expect, it } from "vitest";
import { classifySource, reclassifySourceOnEdit } from "./source-classification";

const FB = "https://www.facebook.com/revolutionaryfair";

describe("reclassifySourceOnEdit", () => {
  it("keeps email_submission when only a citation URL is added (the 13f7f7a4 specimen)", () => {
    const r = reclassifySourceOnEdit({
      currentMethod: "email_submission",
      suggesterEmail: "organizer@example.org",
      sourceName: "Revolutionary Fair Facebook page",
      sourceUrl: FB,
    });
    // Landmark: the naive recompute really would have flipped it.
    expect(classifySource("Revolutionary Fair Facebook page", FB).ingestionMethod).toBe(
      "direct_scrape"
    );
    expect(r.ingestionMethod).toBe("email_submission");
    expect(r.preservedMethod).toBe(true);
    // The domain still refreshes — it IS a property of the URL.
    expect(r.sourceDomain).toBe("facebook.com");
  });

  it.each(["vendor_submission", "community_suggestion", "web_research", "discovery"])(
    "keeps the collection method %s against a domain-only edit",
    (m) => {
      expect(
        reclassifySourceOnEdit({
          currentMethod: m,
          suggesterEmail: null,
          sourceName: null,
          sourceUrl: "https://organizer.example/fair",
        }).ingestionMethod
      ).toBe(m);
    }
  );

  it("keeps even a domain-derived value when the row carries suggester_email — a submitter outranks a hostname", () => {
    const r = reclassifySourceOnEdit({
      currentMethod: "admin_manual",
      suggesterEmail: "x@y.z",
      sourceName: null,
      sourceUrl: "https://organizer.example/",
    });
    expect(r).toMatchObject({ ingestionMethod: "admin_manual", preservedMethod: true });
  });

  it("re-derives a DOMAIN-derived value from the new URL (the case recompute-on-write exists for)", () => {
    const r = reclassifySourceOnEdit({
      currentMethod: "admin_manual",
      suggesterEmail: null,
      sourceName: null,
      sourceUrl: "https://organizer.example/fair",
    });
    expect(r).toMatchObject({
      ingestionMethod: "direct_scrape",
      preservedMethod: false,
      sourceDomain: "organizer.example",
    });
  });

  it("an explicit collection LABEL in source_name wins over a preserved value", () => {
    const r = reclassifySourceOnEdit({
      currentMethod: "email_submission",
      suggesterEmail: "x@y.z",
      sourceName: "daily-discovery",
      sourceUrl: FB,
    });
    expect(r).toMatchObject({ ingestionMethod: "discovery", preservedMethod: false });
  });

  it("a NULL or unknown current value is re-derived, not preserved", () => {
    expect(
      reclassifySourceOnEdit({
        currentMethod: null,
        suggesterEmail: null,
        sourceName: null,
        sourceUrl: FB,
      }).ingestionMethod
    ).toBe("direct_scrape");
    expect(
      reclassifySourceOnEdit({
        currentMethod: "bogus",
        suggesterEmail: null,
        sourceName: null,
        sourceUrl: FB,
      }).ingestionMethod
    ).toBe("direct_scrape");
  });
});
