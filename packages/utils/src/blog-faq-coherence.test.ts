/**
 * OPE-280 — blog FAQ coherence detector. Cases mirror the two production posts
 * the OPE-273 audit found self-contradicting between the `faqs` column (which
 * emits as JSON-LD) and the body `## Q:` blocks (what readers see).
 */
import { describe, it, expect } from "vitest";
import { detectFaqIncoherence } from "./blog-faq-coherence";

function col(pairs: Array<[string, string]>): string {
  return JSON.stringify(pairs.map(([question, answer]) => ({ question, answer })));
}

describe("detectFaqIncoherence", () => {
  it("flags the Bristol parade route-length contradiction (1.5 vs 2.5 miles)", () => {
    const body = `## Q: How long is the parade route?

The parade follows an approximately 1.5 miles route through downtown.`;
    const faqs = col([["How long is the parade route?", "The parade follows a 2.5-mile route."]]);
    const r = detectFaqIncoherence(faqs, body);
    expect(r.incoherent).toBe(true);
    const miles = r.conflicts.find((c) => c.type === "distance_miles");
    expect(miles?.bodyValues).toContain(1.5);
    expect(miles?.columnValues).toContain(2.5);
  });

  it("flags the Maine fairs attendance contradiction (300,000 vs 260,000)", () => {
    const body = `## Q: How big is Fryeburg Fair?

Fryeburg Fair draws 300,000+ visitors over 8 days.`;
    const faqs = col([
      [
        "How big is Fryeburg Fair?",
        "Fryeburg Fair draws approximately 260,000 attendees over eight days.",
      ],
    ]);
    const r = detectFaqIncoherence(faqs, body);
    expect(r.incoherent).toBe(true);
    expect(r.conflicts.some((c) => c.type === "attendance_count")).toBe(true);
  });

  it("does NOT flag when body and column agree on the figure", () => {
    const body = `## Q: How long is the route?

The route is 1.5 miles long.`;
    const faqs = col([["How long is the route?", "It is a 1.5 mile route."]]);
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(false);
  });

  it("does NOT flag when a shared value exists even if the body has extra figures", () => {
    // Body cites the route (1.5) AND parking distance (5); column agrees on 1.5.
    const body = `## Q: Logistics?

The 1.5 mile route ends near parking 5 miles away.`;
    const faqs = col([["Logistics?", "The parade is a 1.5 mile route."]]);
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(false);
  });

  it("does NOT flag on prose outside the FAQ blocks", () => {
    // The 2.5-mile figure is in ordinary body prose, not a `## Q:` block.
    const body = `Some intro prose mentioning a 2.5 mile scenic drive.

## Q: When does it start?

It starts at 10 AM.`;
    const faqs = col([["How long?", "A 1.5 mile route."]]);
    // distance appears only in the column + non-FAQ body → no body-FAQ value → no conflict.
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(false);
  });

  it("ignores clock times (range-vs-point is not a contradiction)", () => {
    const body = `## Q: Start time?

The parade steps off around 10–11 a.m., exact times vary by year.`;
    const faqs = col([["Start time?", "It traditionally steps off at 10:30 AM."]]);
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(false);
  });

  it("returns coherent when either source has no FAQ content", () => {
    expect(detectFaqIncoherence(null, "## Q: x\n\n1.5 miles").incoherent).toBe(false);
    expect(detectFaqIncoherence(col([["q", "1.5 miles"]]), "no faq blocks here").incoherent).toBe(
      false
    );
  });

  it("flags a price contradiction", () => {
    const body = `## Q: Admission?

General admission is $5 at the gate.`;
    const faqs = col([["Admission?", "Tickets are $12 each."]]);
    const r = detectFaqIncoherence(faqs, body);
    expect(r.incoherent).toBe(true);
    expect(r.conflicts.some((c) => c.type === "price_usd")).toBe(true);
  });
});
