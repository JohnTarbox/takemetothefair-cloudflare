import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ClaimListingCTA } from "../ClaimListingCTA";

// OPE-43 (crawl hygiene): the fallback "Claim this free listing" CTA is a
// crawlable GET link. Bingbot was burning ~85% of its crawl budget on these, so
// the link must carry rel="nofollow".
// OPE-64: the fallback now targets the claim WIZARD (/claim/vendor/<slug>)
// instead of jumping straight into /register.
describe("ClaimListingCTA", () => {
  it("renders the claim CTA as a /claim/vendor/<slug> link with rel=nofollow", () => {
    const { container } = render(
      <ClaimListingCTA businessName="Joe's Kettle Corn" vendorSlug="joes-kettle-corn" />
    );

    // The fallback branch (not direct-claim eligible) renders the anchor.
    const anchors = Array.from(container.querySelectorAll("a"));
    const claimLink = anchors.find((a) =>
      (a.getAttribute("href") ?? "").includes("/claim/vendor/")
    );

    expect(claimLink).toBeTruthy();
    const href = claimLink!.getAttribute("href") ?? "";
    expect(href).toContain("/claim/vendor/joes-kettle-corn");

    const rel = claimLink!.getAttribute("rel") ?? "";
    expect(rel.split(/\s+/)).toContain("nofollow");
  });
});
