/**
 * OPE-838 — per-field confidence, not a page-level fact wearing a field's name.
 *
 * The ticket's headline was `event_data_citations.confidence = 0.6` on all three
 * citations of a fetch that succeeded, and OPE-457 scope 3 being "Done" while
 * the observable never moved. The constant was never in the citation writer:
 * `confidenceToScore` maps high/medium/low → 0.9/0.6/0.3 and always did.
 *
 * It was HERE. `calculateMultiEventConfidence` tested `!!metadata.jsonLd` — a
 * PAGE-level boolean — and stamped the answer on every field of every event:
 *
 *   no JSON-LD  → every non-null field "medium" → 0.6   (the reported constant)
 *   JSON-LD     → every non-null field "high"   → 0.9   (the worse direction:
 *                 over-claiming on fields the JSON-LD never mentions, into a
 *                 number OPE-433 grades trust by)
 *
 * The single-event `calculateConfidence` had the per-field test and was right.
 * The two are now one function, so they cannot drift again.
 *
 * ⚠️ Each test here was driven to failure against the page-level ladder before
 * being kept (OPE-6 v3.8).
 */
import { describe, it, expect } from "vitest";
import { fieldConfidenceLadder } from "../ai-extractor";
import type { PageMetadata } from "../types";

const NO_JSONLD: PageMetadata = { title: "Maine Cheese Festival" };
const JSONLD: PageMetadata = {
  title: "Maine Cheese Festival",
  jsonLd: { name: "Maine Cheese Festival", startDate: "2026-09-13" },
};

const EVENT = {
  name: "Maine Cheese Festival",
  startDate: "2026-09-13",
  endDate: "2026-09-13",
  description: "A celebration of Maine's food and artisan community.",
  venueName: null,
};

describe("OPE-838 — the confidence ladder reads the field, not the page", () => {
  it("grades ONLY the fields JSON-LD actually names as high", () => {
    const c = fieldConfidenceLadder(EVENT, JSONLD);
    // Named by the JSON-LD → high.
    expect(c.name).toBe("high");
    expect(c.startDate).toBe("high");
    // Present on the event, ABSENT from the JSON-LD. The page-level ladder
    // called these "high" (0.9) purely because the page had *some* JSON-LD —
    // asserting machine-readable backing for values no machine asserted.
    expect(c.endDate).toBe("medium");
    expect(c.description).toBe("medium");
  });

  it("does not collapse a JSON-LD page's every field to one value", () => {
    // The shape assertion, independent of which bucket each field lands in: a
    // ladder that reads a page-level boolean can only ever produce ONE non-low
    // value, so a test that finds two proves the page-level version is gone.
    const buckets = new Set(
      Object.entries(fieldConfidenceLadder(EVENT, JSONLD))
        .filter(([, v]) => v !== "low")
        .map(([, v]) => v)
    );
    expect(buckets.size).toBeGreaterThan(1);
  });

  it("still grades a null field low, whether or not the page has JSON-LD", () => {
    expect(fieldConfidenceLadder(EVENT, JSONLD).venueName).toBe("low");
    expect(fieldConfidenceLadder(EVENT, NO_JSONLD).venueName).toBe("low");
  });

  it("a page with no JSON-LD is medium — the honest floor, not a bug", () => {
    // This is the specimen's own shape (mainecheesefestival.org has no JSON-LD),
    // and 0.6 remains the right answer for it. What was wrong was that 0.6 was
    // the ONLY answer the multi-event path could ever produce for a real value.
    // A genuine per-field verdict is OPE-465's grounding verifier, not this.
    const c = fieldConfidenceLadder(EVENT, NO_JSONLD);
    expect(c.name).toBe("medium");
    expect(c.startDate).toBe("medium");
    expect(c.description).toBe("medium");
  });

  it("skips internal _-prefixed bookkeeping keys", () => {
    const c = fieldConfidenceLadder({ ...EVENT, _extractId: "e1" }, JSONLD);
    expect(c).not.toHaveProperty("_extractId");
    expect(Object.keys(c).length).toBe(Object.keys(EVENT).length); // positive landmark
  });

  it("treats an explicit undefined the same as null", () => {
    // Object.entries surfaces an explicitly-set undefined. The old ladder tested
    // `value === null` only, so `{ venueName: undefined }` fell through to the
    // page-level branch and could be graded "high" on a JSON-LD page.
    expect(fieldConfidenceLadder({ venueName: undefined }, JSONLD).venueName).toBe("low");
  });

  it("a JSON-LD key present but null does not lift the field to high", () => {
    const meta: PageMetadata = { jsonLd: { endDate: null } };
    expect(fieldConfidenceLadder({ endDate: "2026-09-13" }, meta).endDate).toBe("medium");
  });
});
