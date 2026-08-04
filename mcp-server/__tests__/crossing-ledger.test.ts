/**
 * OPE-330 (D-4) — the crossing ledger.
 *
 * The property under test is not "rows get written" but "a stalled boundary
 * becomes visible". Seven defects this summer were silent boundaries; the
 * ledger only helps if a hold with no exit is distinguishable from one that
 * completed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { recordCrossing, ref } from "../src/inbound/crossing-ledger.js";
import { membraneCrossings } from "../src/schema.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

describe("recordCrossing (OPE-330)", () => {
  it("makes 'what happened to this email?' one query on source_ref", async () => {
    const src = ref.inboundEmail("evt-mail-1");
    await recordCrossing(db, { sourceRef: src, crossingType: "email_to_hold" });
    await recordCrossing(db, {
      sourceRef: src,
      destinationRef: ref.event("e-9"),
      crossingType: "hold_to_resolve",
      actor: "human",
    });

    const rows = await db
      .select()
      .from(membraneCrossings)
      .where(eq(membraneCrossings.sourceRef, src));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.crossingType).sort()).toEqual(["email_to_hold", "hold_to_resolve"]);
  });

  it("leaves destination NULL on a hold — the absence IS the signal", async () => {
    await recordCrossing(db, {
      sourceRef: ref.inboundEmail("stuck"),
      crossingType: "email_to_hold",
    });
    const [row] = await db.select().from(membraneCrossings);
    expect(row.destinationRef).toBeNull();
  });

  it("distinguishes a stalled hold from a resolved one", async () => {
    // This is the whole point. Both start identically; only the exit differs.
    await recordCrossing(db, { sourceRef: ref.inboundEmail("a"), crossingType: "email_to_hold" });
    await recordCrossing(db, { sourceRef: ref.inboundEmail("b"), crossingType: "email_to_hold" });
    await recordCrossing(db, {
      sourceRef: ref.inboundEmail("b"),
      destinationRef: ref.event("e-1"),
      crossingType: "hold_to_resolve",
    });

    const all = await db.select().from(membraneCrossings);
    const holds = all.filter((r) => r.crossingType === "email_to_hold").map((r) => r.sourceRef);
    const exits = new Set(
      all.filter((r) => r.crossingType === "hold_to_resolve").map((r) => r.sourceRef)
    );
    const stalled = holds.filter((h) => !exits.has(h));
    expect(stalled).toEqual([ref.inboundEmail("a")]);
  });

  it("records who caused the crossing", async () => {
    await recordCrossing(db, {
      sourceRef: ref.inboundEmail("x"),
      crossingType: "hold_to_resolve",
      actor: "human",
    });
    const [row] = await db.select().from(membraneCrossings);
    expect(row.actor).toBe("human");
  });

  it("defaults the actor to system rather than leaving it unknown", async () => {
    await recordCrossing(db, { sourceRef: ref.inboundEmail("y"), crossingType: "email_to_ticket" });
    const [row] = await db.select().from(membraneCrossings);
    expect(row.actor).toBe("system");
  });

  it("NEVER throws — a broken ledger must not break the pipeline it observes", async () => {
    // The failure mode to avoid: "the email wasn't processed" instead of
    // "we don't know what happened to the email".
    const brokenDb = {
      insert: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as TestDb;
    await expect(
      recordCrossing(brokenDb, { sourceRef: "x", crossingType: "email_to_ticket" })
    ).resolves.toBeUndefined();
  });

  it("spells refs one way", () => {
    expect(ref.inboundEmail("abc")).toBe("inbound_email:abc");
    expect(ref.event("e1")).toBe("event:e1");
    expect(ref.issue("OPE-330")).toBe("issue:OPE-330");
  });
});
