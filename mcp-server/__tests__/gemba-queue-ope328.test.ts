/**
 * OPE-328 (Demux D-3) — gemba@ is one address; each observation is tagged with
 * a project on its CONTENT (D-1's domain rule would call every one `mmatf`),
 * queued in D1, and posted to Linear by an agent session. Ambiguous → held.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { gembaObservations, inboundEmails } from "../src/schema.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
const { routeGembaObservation } = await import("../src/inbound/gemba.js");
const { handle: handleGemba } = await import("../src/email-handlers/gemba.js");
const { registerGembaTools } = await import("../src/tools/admin-gemba.js");
const { resolveIntent, shouldForwardToAdmin } = await import("../src/email-intents.js");

describe("routeGembaObservation", () => {
  it("an MMATF observation is pending on OPE-86", () => {
    expect(
      routeGembaObservation("[mmatf] vendor page is confusing", "The claim button is hidden.")
    ).toEqual({
      project: "mmatf",
      anchorIssue: "OPE-86",
      status: "pending",
      reason: "subject tag: mmatf",
    });
    expect(
      routeGembaObservation("Saw this at the fair", "The promoter couldn't find their venue page.")
        .project
    ).toBe("mmatf");
  });
  it("a project with no anchor yet is held, not guessed", () => {
    expect(routeGembaObservation("cardworks storefront idea", null)).toMatchObject({
      project: "cardworks",
      status: "held",
    });
  });
  it("no signal, or two projects at once, is held and asks", () => {
    expect(routeGembaObservation("Thought on Tuesday", "Something felt off.")).toMatchObject({
      status: "held",
      project: null,
    });
    expect(routeGembaObservation("vendor page + OPE-123 ledger", null)).toMatchObject({
      status: "held",
      project: null,
    });
  });
});

describe("the lane", () => {
  it("gemba@ maps to its own intent and is not forwarded back to the admin", () => {
    expect(resolveIntent("gemba@meetmeatthefair.com")).toBe("gemba_observation");
    expect(shouldForwardToAdmin("gemba_observation")).toBe(false);
  });
});

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
  harness.db = db;
  db.insert(inboundEmails)
    .values({
      id: "in-g1",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "jtarboxme@gmail.com",
      toAddress: "gemba@meetmeatthefair.com",
      subject: "[mmatf] the hub page hides the guide",
      bodyText: "Fryeburg hub: the visitor guide is below the fold on mobile.",
      intent: "gemba_observation",
      status: "processing",
    } as never)
    .run();
});

describe("handler + tools", () => {
  it("the handler queues the observation, sends nothing, and is idempotent", async () => {
    const row = db.select().from(inboundEmails).all()[0];
    const r1 = await handleGemba({ DB: {} } as never, {} as never, row as never);
    const r2 = await handleGemba({ DB: {} } as never, {} as never, row as never);
    expect(r1).toEqual({ replyKind: null, status: "forwarded" });
    expect(r2.replyKind).toBeNull();
    const queued = db.select().from(gembaObservations).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      inboundEmailId: "in-g1",
      project: "mmatf",
      anchorIssue: "OPE-86",
      status: "pending",
    });
  });

  it("list → post → posted; a held row is routed to pending", async () => {
    db.insert(gembaObservations)
      .values([
        {
          id: "g1",
          inboundEmailId: "in-g1",
          project: "mmatf",
          anchorIssue: "OPE-86",
          status: "pending",
          routingReason: "subject tag: mmatf",
          createdAt: new Date(),
        },
        {
          id: "g2",
          inboundEmailId: "in-g2",
          project: null,
          anchorIssue: null,
          status: "held",
          routingReason: "no project tag",
          createdAt: new Date(),
        },
      ] as never)
      .run();
    const server = new CapturingMcpServer();
    registerGembaTools(server as never, db as never, { userId: "u-admin", role: "ADMIN" } as never);
    const listed = JSON.parse(
      ((await server.invoke("list_gemba_observations", {})) as { content: { text: string }[] })
        .content[0].text
    );
    expect(
      listed.observations.map((o: { id: string; subject: string }) => [o.id, o.subject])
    ).toEqual([["g1", "[mmatf] the hub page hides the guide"]]);
    await server.invoke("mark_gemba_observation", {
      id: "g1",
      action: "posted",
      posted_ref: "linear-comment-abc",
    });
    expect(
      db.select().from(gembaObservations).where(eq(gembaObservations.id, "g1")).all()[0]
    ).toMatchObject({
      status: "posted",
      postedRef: "linear-comment-abc",
    });
    const noAnchor = (await server.invoke("mark_gemba_observation", {
      id: "g2",
      action: "route",
      project: "cardworks",
    })) as { isError?: boolean };
    expect(noAnchor.isError).toBe(true);
    await server.invoke("mark_gemba_observation", { id: "g2", action: "route", project: "mmatf" });
    expect(
      db.select().from(gembaObservations).where(eq(gembaObservations.id, "g2")).all()[0]
    ).toMatchObject({
      status: "pending",
      anchorIssue: "OPE-86",
    });
  });
});
