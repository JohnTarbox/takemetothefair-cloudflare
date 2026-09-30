/**
 * OPE-714 — `force` lets a reviewed disagreement actually be applied.
 *
 * `review_enrichment_candidate.approve` is fill-empty-only. A `vendor_type`
 * disagreement receipt is ONLY staged when the stored value differs from the
 * proposal, so **95 of 95** in prod land on the non-fillable path: approve and
 * reject were behaviourally identical for every one of them, and the queue
 * could only ever drain to no effect. Fine Fettle — a cannabis dispensary
 * stored as "Home Improvement" — was unreachable by the tool built to reach it.
 *
 * `force` is the deliberate override. It defaults false, and what it replaced
 * is recorded, because an overwrite nobody can undo is not a review.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, users, vendorEnrichmentCandidates, vendors } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH);

  db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
  db.insert(vendors)
    .values({
      id: "v-1",
      userId: "u-v",
      businessName: "Fine Fettle",
      slug: "fine-fettle",
      vendorType: "Home Improvement", // the wrong stored value
    })
    .run();
  db.insert(vendorEnrichmentCandidates)
    .values({
      id: 1,
      vendorId: "v-1",
      jobRunId: "job-1",
      extractionMethod: "manual",
      proposedField: "vendor_type",
      currentValue: "Home Improvement",
      proposedValue: "Cannabis Dispensary",
      sourceUrl: "https://finefettle.com",
      decision: "pending",
      flags: "[]",
      createdAt: new Date(),
    })
    .run();
});

const vendorRow = () => db.select().from(vendors).where(eq(vendors.id, "v-1")).all()[0];
const candidate = () =>
  db.select().from(vendorEnrichmentCandidates).where(eq(vendorEnrichmentCandidates.id, 1)).all()[0];
const body = (r: { content: { text?: string }[] }) => JSON.parse(r.content[0].text ?? "{}");

describe("OPE-714 — without force, the disagreement is unreachable", () => {
  it("approve leaves the stored value untouched and says why", async () => {
    const res = (await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "approve",
    })) as { content: { text?: string }[] };

    expect(vendorRow().vendorType).toBe("Home Improvement"); // unchanged
    expect(body(res).applied).toBe(false);
    expect(body(res).reason).toBe("field_already_populated");
    // It still leaves the queue — that is the existing, deliberate behaviour.
    expect(candidate().decision).toBe("approved");
  });
});

describe("OPE-714 — force applies it, and records what it replaced", () => {
  it("ACCEPTANCE: the cannabis dispensary stops reading 'Home Improvement'", async () => {
    const res = (await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "approve",
      force: true,
      note: "organizer page confirms dispensary",
    })) as { content: { text?: string }[] };

    expect(vendorRow().vendorType).toBe("Cannabis Dispensary");
    expect(body(res).applied).toBe(true);
    expect(body(res).forced).toBe(true);
    expect(body(res).overwrote).toBe("Home Improvement");
    expect(candidate().decision).toBe("approved");
  });

  it("the replaced value is in the AUDIT row — without it the force is irreversible", async () => {
    await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "approve",
      force: true,
    });

    const audit = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "vendor.enrichment_review"))
      .all();
    expect(audit).toHaveLength(1);
    const payload = JSON.parse(audit[0].payloadJson ?? "{}");
    expect(payload.forced).toBe(true);
    expect(payload.overwrote).toBe("Home Improvement");
    expect(payload.proposed_value).toBe("Cannabis Dispensary");
  });

  it("a NORMAL fill is not marked forced — the flag means something", async () => {
    // Empty the field so the ordinary fill-empty path runs.
    db.update(vendors).set({ vendorType: null }).where(eq(vendors.id, "v-1")).run();

    const res = (await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "approve",
      force: true, // passed, but irrelevant — the field was empty
    })) as { content: { text?: string }[] };

    expect(vendorRow().vendorType).toBe("Cannabis Dispensary");
    expect(body(res).applied).toBe(true);
    expect(body(res).forced).toBeUndefined();
    expect(body(res).overwrote).toBeUndefined();
  });
});

describe("OPE-714 — force overrides fill-empty-only and NOTHING else", () => {
  it("it does not resurrect an already-reviewed candidate", async () => {
    db.update(vendorEnrichmentCandidates)
      .set({ decision: "rejected" })
      .where(eq(vendorEnrichmentCandidates.id, 1))
      .run();

    const res = (await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "approve",
      force: true,
    })) as { isError?: boolean; content: { text?: string }[] };

    expect(res.isError).toBe(true);
    expect(body(res).error).toBe("already_reviewed");
    expect(vendorRow().vendorType).toBe("Home Improvement");
  });

  it("it does not force a REJECT into a write", async () => {
    const res = (await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "reject",
      force: true,
    })) as { content: { text?: string }[] };

    expect(vendorRow().vendorType).toBe("Home Improvement");
    expect(body(res).applied).toBe(false);
    expect(candidate().decision).toBe("rejected");
  });

  it("default is false — an existing caller cannot overwrite by accident", async () => {
    await server.invoke("review_enrichment_candidate", { candidate_id: 1, action: "approve" });
    expect(vendorRow().vendorType).toBe("Home Improvement");
  });
});
