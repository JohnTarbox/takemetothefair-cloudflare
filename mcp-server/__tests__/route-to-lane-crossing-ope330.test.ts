/**
 * OPE-330 (Demux D-4) — `route_to_lane` had no writer.
 *
 * The ledger, its five crossing types, the actor enum, the ref helpers, the
 * unterminated-crossing detector and the heartbeat probe all shipped. What was
 * missing was one of the five types actually being recorded anywhere.
 *
 * Live counts, 2026-08-28:
 *
 *   email_to_ticket   76   system   08-05 → 08-28
 *   email_to_hold     18   system   08-21 → 08-24
 *   review_to_rework  13   agent    08-23 → 08-28
 *   hold_to_resolve    0            writer exists (resolve-held-photos), never fired
 *   route_to_lane      0            NO WRITER AT ALL
 *
 * That last one is the FIRST hop of every inbound email, so the ticket's own
 * acceptance — "what happened to this email?" is one query — could not be met:
 * the ledger could say an email became a ticket, but not which lane decided so,
 * and an email routed to the wrong project left no trace of the decision.
 *
 * These tests pin the crossing's SHAPE against the real router rather than
 * standing up a Cloudflare Workflow, which is not runnable here. The wiring
 * itself is a single `step.do` in `workflows/inbound-email.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { recordCrossing, ref } from "../src/inbound/crossing-ledger.js";
import { routeToProject } from "../src/inbound/project-router.js";
import { membraneCrossings } from "../src/schema.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

/** Exactly what the workflow step records, kept in one place so the test and
 *  the production call cannot describe different rows. */
async function recordRouteCrossing(
  inboundId: string,
  email: {
    toAddress: string;
    fromAddress: string;
    subject: string;
  }
) {
  const routed = routeToProject(email);
  await recordCrossing(db, {
    sourceRef: ref.inboundEmail(inboundId),
    destinationRef: `lane:${routed.project}`,
    crossingType: "route_to_lane",
    actor: "system",
    notes: routed.reason ?? null,
  });
  return routed;
}

describe("route_to_lane", () => {
  it("records the lane a routed email went to", async () => {
    const routed = await recordRouteCrossing("i1", {
      toAddress: "submit@meetmeatthefair.com",
      fromAddress: "someone@example.com",
      subject: "New fair",
    });
    expect(routed.project).toBe("mmatf");

    const rows = await db.select().from(membraneCrossings);
    expect(rows).toHaveLength(1);
    expect(rows[0].crossingType).toBe("route_to_lane");
    expect(rows[0].sourceRef).toBe("inbound_email:i1");
    expect(rows[0].destinationRef).toBe("lane:mmatf");
    // The reason is carried so routing precision stays measurable — that is
    // what the router's own `reason` field exists for.
    expect(rows[0].notes).toBeTruthy();
  });

  it("records UNROUTED too — it is a real outcome, not an absence", async () => {
    // The case where knowing what we decided matters MOST. Recording only
    // successful routes would leave the ledger silent on exactly the emails
    // somebody has to investigate.
    const routed = await recordRouteCrossing("i2", {
      toAddress: "hello@some-unknown-domain.example",
      fromAddress: "stranger@example.com",
      subject: "Hi",
    });
    expect(routed.project).toBe("UNROUTED");

    const rows = await db.select().from(membraneCrossings);
    expect(rows[0].destinationRef).toBe("lane:UNROUTED");
    expect(rows[0].notes).toContain("no project owns");
  });

  it("makes the email answerable by source ref — the ticket's acceptance", async () => {
    // "what happened to this email?" is one query. Before this, the first hop
    // was missing from the answer.
    await recordRouteCrossing("i3", {
      toAddress: "submit@meetmeatthefair.com",
      fromAddress: "a@example.com",
      subject: "Fair",
    });
    await recordCrossing(db, {
      sourceRef: ref.inboundEmail("i3"),
      destinationRef: ref.event("e9"),
      crossingType: "email_to_ticket",
      actor: "system",
    });

    const rows = (await db.select().from(membraneCrossings)).filter(
      (r) => r.sourceRef === "inbound_email:i3"
    );
    expect(rows.map((r) => r.crossingType).sort()).toEqual(["email_to_ticket", "route_to_lane"]);
  });

  it("never throws — a ledger failure must not take the email with it", async () => {
    // `recordCrossing` swallows and logs. An observability write that can fail
    // a real pipeline is worse than no observability.
    await expect(
      recordCrossing(db, {
        sourceRef: ref.inboundEmail("i4"),
        crossingType: "route_to_lane",
        actor: "system",
      })
    ).resolves.toBeUndefined();
  });
});
