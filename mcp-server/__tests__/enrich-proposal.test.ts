import { describe, it, expect } from "vitest";
import { computeFillEmptyProposals } from "../src/email-handlers/enrich-proposal.js";

// OPE-175 — fill-empty-only enrichment proposals for dedup-on-match. The core
// guarantee (acceptance): a populated existing field is NEVER proposed, so
// curated data can't be overwritten; only truly-empty fields get a proposal.
describe("computeFillEmptyProposals", () => {
  const incoming = {
    imageUrl: "https://cdn/x.webp",
    sourceUrl: "https://organizer.org/event",
    description: "A great fair.",
  };

  it("proposes all three when the existing event has them all empty", () => {
    expect(
      computeFillEmptyProposals({ imageUrl: null, sourceUrl: "", description: "  " }, incoming)
    ).toEqual({
      image_url: "https://cdn/x.webp",
      source_url: "https://organizer.org/event",
      description: "A great fair.",
    });
  });

  it("NEVER proposes a field the existing event already has (fill-empty only)", () => {
    const existing = {
      imageUrl: "https://cdn/curated.jpg",
      sourceUrl: "https://official.example/e",
      description: "Curated copy.",
    };
    expect(computeFillEmptyProposals(existing, incoming)).toEqual({});
  });

  it("proposes only the empty fields, leaving populated ones untouched", () => {
    const existing = { imageUrl: "https://cdn/curated.jpg", sourceUrl: null, description: null };
    expect(computeFillEmptyProposals(existing, incoming)).toEqual({
      source_url: "https://organizer.org/event",
      description: "A great fair.",
    });
  });

  it("skips a field when the incoming value is empty/absent even if existing is empty", () => {
    expect(
      computeFillEmptyProposals(
        { imageUrl: null, sourceUrl: null, description: null },
        { imageUrl: "", sourceUrl: undefined, description: "   " }
      )
    ).toEqual({});
  });

  it("treats whitespace-only existing values as empty (fillable)", () => {
    expect(
      computeFillEmptyProposals({ description: "   \n " }, { description: "Real description." })
    ).toEqual({ description: "Real description." });
  });

  it("trims the proposed value", () => {
    expect(
      computeFillEmptyProposals({ sourceUrl: null }, { sourceUrl: "  https://o.org/e  " })
    ).toEqual({ source_url: "https://o.org/e" });
  });
});
