import { describe, it, expect } from "vitest";
import { submitEventSchema } from "../schema";

// Regression test for the 2026-05-25 bare-URL email submission failure.
//
// Symptom: emails to submit@meetmeatthefair.com whose body is just a URL
// failed with `NonRetryableError: submit-400: Invalid input: expected
// array, received null`. Three inbound_emails rows confirmed
// (ebf88d81 Shaker Hill, b2667685 SH Apple, 3ee1848c Farmington
// markets) — every URL-only submission since the dedup-step PR
// silently lost the event.
//
// Root cause: AI extractor at src/lib/url-import/ai-extractor.ts
// emits `specificDates: null` (typed string[] | null) when no
// recurring dates are detected. The inbound-email workflow at
// mcp-server/src/workflows/inbound-email.ts spreads
// `...extracted.event` into the submit body verbatim, so `null`
// reached the validator. The schema used `.optional()` (accepts
// undefined only); changing to `.nullable().optional()` treats null
// the same as absent — which is exactly what the downstream
// expansion logic already does (`data.specificDates && ...length`).
//
// This test pins the contract: the bare-URL payload shape must
// parse without 400.
describe("submitEventSchema null tolerance on array fields", () => {
  it("accepts specificDates: null (URL-only AI extraction path)", () => {
    const result = submitEventSchema.safeParse({
      name: "Shaker Hill Apple Festival",
      sourceUrl: "https://alfredshakermuseum.org/",
      source: "email",
      suggesterEmail: "submitter@example.com",
      // The AI extractor returns these as null when nothing matches:
      specificDates: null,
      eventDays: null,
      // And these as null when no value extracted:
      description: null,
      startDate: null,
      endDate: null,
      venueName: null,
      venueAddress: null,
      categories: null,
    });
    expect(result.success).toBe(true);
  });

  it("still rejects non-array, non-null values for specificDates", () => {
    const result = submitEventSchema.safeParse({
      name: "Bad Event",
      specificDates: "2026-05-25",
    });
    expect(result.success).toBe(false);
  });

  it("accepts the standard happy-path payload (array with dates)", () => {
    const result = submitEventSchema.safeParse({
      name: "Recurring Farmers' Market",
      specificDates: ["2026-06-07", "2026-06-14", "2026-06-21"],
      discontinuousDates: true,
    });
    expect(result.success).toBe(true);
  });
});
