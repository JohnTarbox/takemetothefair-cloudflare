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

  it("DOES flag a single-fact claim in prose outside the FAQ blocks", () => {
    // ⚠️ This assertion was REVERSED in the OPE-280 rework, deliberately.
    //
    // It previously asserted `false` — prose outside a `## Q:` block was out of
    // scope by design. That is exactly why the detector missed the Bristol
    // specimen it was built for: the contradicted "approximately 1.5 miles in
    // length" sits in a bold LABEL line (`**Route**: …`), which is prose.
    //
    // Single-fact types (distance, attendance) are now compared against the
    // whole body. Multi-valued ones (price) are not — see WHOLE_BODY_TYPES.
    const body = `Some intro prose mentioning a 2.5 mile scenic drive.

## Q: When does it start?

It starts at 10 AM.`;
    const faqs = col([["How long?", "A 1.5 mile route."]]);
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(true);
  });

  it("extracts FAQs written as bold questions, not just `## Q:` headings", () => {
    // THE root cause of the 0/100 sweep: neither specimen post contained a
    // single `## Q:` heading, so the body side was empty and the comparison
    // short-circuited before any rule ran. Both write FAQs as bold questions.
    const body = `## Maine Fairs

**What's the biggest fair in Maine?**
The Fryeburg Fair is Maine's largest, drawing 300,000+ visitors over 8 days.`;
    const faqs = col([
      ["What's the biggest fair in Maine?", "Fryeburg draws approximately 260,000 attendees."],
    ]);
    const r = detectFaqIncoherence(faqs, body);
    expect(r.incoherent).toBe(true);
    expect(r.conflicts[0]).toMatchObject({
      type: "attendance_count",
      bodyValues: [300000],
      columnValues: [260000],
    });
  });

  it("does NOT mistake a bold LABEL for a bold question", () => {
    // `**Route**:` is prose scaffolding, not an FAQ heading. Capturing it would
    // pull most of a post's body into the "FAQ region" and make the multi-valued
    // types noisy again.
    const body = `**Route**: The parade proceeds down Hope Street.
**Lodging**: Bristol is 20 miles south of Providence.
Admission is $25 at the gate.`;
    const faqs = col([["Cost?", "Gate admission is $10."]]);
    // Price is FAQ-region-only, and there is no FAQ region here → no conflict.
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(false);
  });

  it("does not compare a vendor booth fee against gate admission", () => {
    // Measured false positives from the first full sweep: paradise-city
    // (body $100 vs column $14) and laudholm (body $25/$500 vs column $10).
    // Booth fees and gate admission answer different questions.
    const body = `## Q: What does a booth cost?

Vendor booths start at $500 for the weekend.`;
    const faqs = col([["What is admission?", "Gate admission is $10 per person."]]);
    expect(detectFaqIncoherence(faqs, body).incoherent).toBe(false);
  });

  it("still flags a genuine admission-price contradiction", () => {
    const body = `## Q: How much is admission?

Gate admission is $25 per person.`;
    const faqs = col([["How much is admission?", "Admission costs $10."]]);
    const r = detectFaqIncoherence(faqs, body);
    expect(r.incoherent).toBe(true);
    expect(r.conflicts[0].type).toBe("price_usd");
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

/**
 * OPE-1015 — the Old Deerfield specimen, from its PRE-FIX values (the live row
 * was corrected 2026-09-14, so it no longer reproduces). Body text is the
 * ticket's quoted sentences placed in the sections they came from.
 */
const DEERFIELD_BODY = `# Old Deerfield Craft Fairs: A Guide for Vendors and Visitors

## Two Locations, One Producer

A point of frequent confusion: only the September festival is physically held in Deerfield. The Spring and Holiday Samplers are held at the Eastern States Exposition's indoor facility about 35 miles south, in West Springfield.

## The Fall Festival

The September festival fills the lawns around Memorial Hall Museum. Admission is free; the surrounding 18th-century historic district is open for tours.

## The Spring Sampler

A smaller indoor show. Admission is free.

## The Holiday Sampler

Free admission.`;

const DEERFIELD_FAQS = col([
  [
    "Where are the Old Deerfield Craft Fairs held?",
    "All three events are held at Memorial Hall Museum in Old Deerfield, Massachusetts.",
  ],
  [
    "How much is admission?",
    "Adult gate admission at the Old Deerfield Craft Fairs is approximately $8-$10 with discounts for children, seniors, and members.",
  ],
  [
    "What are the Samplers?",
    "The Spring and Holiday Samplers are smaller indoor shows held in Memorial Hall Museum.",
  ],
]);

describe("OPE-1015 — admission_free_vs_paid", () => {
  it("flags the Deerfield specimen: body free-only vs column $8-$10", () => {
    const r = detectFaqIncoherence(DEERFIELD_FAQS, DEERFIELD_BODY);
    const c = r.conflicts.find((x) => x.type === "admission_free_vs_paid");
    expect(c?.bodyValues).toEqual([0]);
    expect(c?.columnValues).toEqual(expect.arrayContaining([8]));
  });

  it("flags the mirror case: column free-only vs body paid", () => {
    const r = detectFaqIncoherence(
      col([["Does it cost anything?", "Admission is free for everyone."]]),
      "## Getting in\n\nGate admission is $12 at the door."
    );
    expect(r.conflicts.some((x) => x.type === "admission_free_vs_paid")).toBe(true);
  });

  it("does NOT fire on a multi-show guide that says both free and paid", () => {
    const r = detectFaqIncoherence(
      col([["How much is admission?", "Admission to the fall festival is $7."]]),
      "The fall festival admission is $7. The spring sampler? Admission is free."
    );
    expect(r.conflicts.some((x) => x.type === "admission_free_vs_paid")).toBe(false);
  });

  it("does NOT treat 'free for children' as a free-admission claim", () => {
    const r = detectFaqIncoherence(
      col([["How much is admission?", "Gate admission is $10."]]),
      "Admission is free for children under 12. Kids receive free admission all weekend."
    );
    expect(r.conflicts.some((x) => x.type === "admission_free_vs_paid")).toBe(false);
  });

  it("does NOT fire on free parking or a free shuttle", () => {
    const r = detectFaqIncoherence(
      col([["How much is admission?", "Gate admission is $10."]]),
      "Parking is free and there is a free shuttle from town."
    );
    expect(r.conflicts.some((x) => x.type === "admission_free_vs_paid")).toBe(false);
  });
});

describe("OPE-1015 — venue_all_events", () => {
  it("flags the Deerfield specimen: 'all three held at Memorial Hall' vs Samplers at Eastern States", () => {
    const r = detectFaqIncoherence(DEERFIELD_FAQS, DEERFIELD_BODY);
    const c = r.conflicts.find((x) => x.type === "venue_all_events");
    expect(c).toBeDefined();
    expect(c?.bodyValues.join(" ")).toContain("Eastern States Exposition");
    expect(c?.columnValues.join(" ")).toContain("Memorial Hall Museum");
    // The sentence naming the town of the column's venue must not be the conflict.
    expect(c?.bodyValues.join(" ")).not.toMatch(/^Deerfield$/m);
  });

  it("does NOT fire when the column's venue claim is not universal (a multi-show post doing its job)", () => {
    const r = detectFaqIncoherence(
      col([["Where is the fall show?", "The fall show is held at Memorial Hall Museum."]]),
      DEERFIELD_BODY
    );
    expect(r.conflicts.some((x) => x.type === "venue_all_events")).toBe(false);
  });

  it("does NOT fire on an alias in the same sentence ('the Big E')", () => {
    const r = detectFaqIncoherence(
      col([["Where?", "All shows are held at the Big E in West Springfield."]]),
      "Every sampler is held at the Eastern States Exposition (the Big E), West Springfield."
    );
    expect(r.conflicts.some((x) => x.type === "venue_all_events")).toBe(false);
  });

  it("does NOT fire on the venue's own town ('held in Deerfield')", () => {
    const r = detectFaqIncoherence(
      col([["Where?", "Both days are held at Memorial Hall Museum in Old Deerfield."]]),
      "The festival is held in Deerfield every September."
    );
    expect(r.conflicts.some((x) => x.type === "venue_all_events")).toBe(false);
  });

  it("does NOT fire on a distance phrase ('35 miles south')", () => {
    const r = detectFaqIncoherence(
      col([["Where?", "All events are held at Memorial Hall Museum."]]),
      "The fair is about 35 miles south of Greenfield, and parking is plentiful."
    );
    expect(r.conflicts.some((x) => x.type === "venue_all_events")).toBe(false);
  });
});
