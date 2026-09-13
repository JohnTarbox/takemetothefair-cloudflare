/**
 * OPE-988 — the workflow side: a source-agreement disagreement becomes ONE open
 * `existence` / `source_agreement` discrepancy, is never an outreach candidate,
 * and is not re-filed while the row is open.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { captureSourceAgreementDisagreements } from "../src/goodwill/source-agreement-capture.js";
import { eventDiscrepancies, events } from "../src/schema.js";

let db: TestDb;

const FINDING = {
  eventId: "evt-leo",
  slug: "johnny-appleseed-arts-and-cultural-festival",
  sourceUrl: "https://www.johnnyappleseedfest.com/",
  city: "Leominster",
  state: "MA",
  venueName: "Downtown Leominster (Monument Square)",
  otherStates: ["IN"],
  signals: ["other-state:IN(address)"],
  detail: "page never names Leominster and places itself in Indiana, not Massachusetts",
};

beforeEach(async () => {
  ({ db } = createTestDb());
  await db.insert(events).values({
    id: "evt-leo",
    name: "Johnny Appleseed Arts and Cultural Festival",
    slug: "johnny-appleseed-arts-and-cultural-festival",
    promoterId: "p-1",
    status: "APPROVED",
  });
});

describe("OPE-988 captureSourceAgreementDisagreements", () => {
  it("files one open existence row, detected_by source_agreement, never an outreach candidate", async () => {
    const r = await captureSourceAgreementDisagreements(db, [FINDING]);
    expect(r).toEqual({ filed: 1, refreshedOrFailed: 0, malformed: 0 });

    const rows = await db.select().from(eventDiscrepancies);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: "evt-leo",
      fieldClass: "existence",
      detectedBy: "source_agreement",
      resolutionStatus: "open",
      outreachCandidate: false,
      divergentValue: "IN",
      divergentSourceKey: "johnnyappleseedfest.com",
      divergentSourceUrl: "https://www.johnnyappleseedfest.com/",
      authoritativeValue: "Downtown Leominster (Monument Square), Leominster, MA",
    });
    expect(rows[0].notes).toContain("OPE-988");
  });

  it("is idempotent while the row is open — tomorrow's sweep refreshes, never re-files", async () => {
    await captureSourceAgreementDisagreements(db, [FINDING]);
    const again = await captureSourceAgreementDisagreements(db, [FINDING]);
    expect(again.filed).toBe(0);
    expect(await db.select().from(eventDiscrepancies)).toHaveLength(1);
  });

  it("skips a malformed finding instead of throwing", async () => {
    const r = await captureSourceAgreementDisagreements(db, [{ nope: true }, null]);
    expect(r).toEqual({ filed: 0, refreshedOrFailed: 0, malformed: 2 });
    expect(await db.select().from(eventDiscrepancies)).toHaveLength(0);
  });
});
