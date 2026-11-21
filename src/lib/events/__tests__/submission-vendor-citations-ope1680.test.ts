/**
 * OPE-1680 — the suggest-event submit route stores a vendor fee / application
 * deadline only with a `user_submitted` citation behind it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSubmissionVendorCitations,
  submissionCitationSourceUrl,
  type SubmissionVendorValues,
} from "../submission-vendor-citations";

const now = new Date("2026-11-18T08:00:00Z");
const base: SubmissionVendorValues = {
  eventId: "ev1",
  sourceUrl: "https://fair.example.org/vendors",
  sourceName: "vendor-submission",
  ingestionMethod: "vendor_submission",
  createdBy: "user-1",
  vendorFeeMin: { submitted: undefined, storedCents: null },
  vendorFeeMax: { submitted: undefined, storedCents: null },
  applicationDeadline: { submitted: undefined, stored: null },
  now,
};

describe("buildSubmissionVendorCitations", () => {
  it("writes one active user_submitted row per stored field, value as submitted", () => {
    const rows = buildSubmissionVendorCitations({
      ...base,
      vendorFeeMin: { submitted: 40, storedCents: 4000 },
      vendorFeeMax: { submitted: 0, storedCents: 0 }, // a free booth is a real value
      applicationDeadline: { submitted: "2026-12-01", stored: new Date("2026-12-01T12:00:00Z") },
    });
    expect(rows.map((r) => [r.fieldName, r.value])).toEqual([
      ["vendor_fee_min", "40"],
      ["vendor_fee_max", "0"],
      ["application_deadline", "2026-12-01"],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        eventId: "ev1",
        sourceUrl: "https://fair.example.org/vendors",
        sourceType: "user_submitted",
        state: "active",
        createdBy: "user-1",
        year: null,
      });
      expect(r.notes).toContain("vendor_submission");
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it("writes nothing for a value the route did not store", () => {
    // Landmark first: the same shape with a stored value does produce a row.
    expect(
      buildSubmissionVendorCitations({
        ...base,
        vendorFeeMin: { submitted: 40, storedCents: 4000 },
      })
    ).toHaveLength(1);
    expect(buildSubmissionVendorCitations(base)).toEqual([]);
    expect(
      buildSubmissionVendorCitations({
        ...base,
        vendorFeeMin: { submitted: 40, storedCents: null },
        applicationDeadline: { submitted: "garbage", stored: null },
      })
    ).toEqual([]);
  });

  it("with no source URL, the submission itself is the source", () => {
    expect(submissionCitationSourceUrl("ev9", null)).toBe("submission://suggest-event/ev9");
    expect(submissionCitationSourceUrl("ev9", "  ")).toBe("submission://suggest-event/ev9");
    const [row] = buildSubmissionVendorCitations({
      ...base,
      eventId: "ev9",
      sourceUrl: undefined,
      createdBy: undefined,
      vendorFeeMax: { submitted: 75, storedCents: 7500 },
    });
    expect(row.sourceUrl).toBe("submission://suggest-event/ev9");
    expect(row.createdBy).toBeNull();
  });
});

describe("the submit route wires it", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/suggest-event/submit/route.ts"),
    "utf8"
  );
  it("stores the same resolved values it cites", () => {
    expect(ROUTE).toContain("vendorFeeMinCents: storedVendorFeeMinCents,");
    expect(ROUTE).toContain("vendorFeeMaxCents: storedVendorFeeMaxCents,");
    expect(ROUTE).toContain("applicationDeadline: storedApplicationDeadline,");
  });
  it("inserts the citations after the event row", () => {
    const eventInsert = ROUTE.indexOf("await db.insert(events).values({\n      id: newEventId");
    const citeInsert = ROUTE.indexOf(
      "await db.insert(eventDataCitations).values(vendorCitationRows)"
    );
    expect(eventInsert).toBeGreaterThan(-1);
    expect(citeInsert).toBeGreaterThan(eventInsert);
  });
});
