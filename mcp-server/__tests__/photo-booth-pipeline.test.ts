import { describe, it, expect, vi } from "vitest";
import {
  runBoothPipeline,
  BOOTH_PROPOSED_ACTION,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import { createTestDb } from "./setup-db.js";
import type { Db } from "../src/db.js";
import { adminActions, inboundEmails } from "../src/schema.js";
import { eq } from "drizzle-orm";

const reply = (over: Record<string, unknown> = {}) => ({
  response: JSON.stringify({
    kind: "booth",
    business_name: "Maple Hollow Farm",
    website: null,
    products: ["syrup"],
    confidence: 0.9,
    rationale: "banner on the stall",
    ...over,
  }),
});

/** R2 stub returning fixed bytes for any key. */
const bucket = (present = true) =>
  ({
    get: vi
      .fn()
      .mockResolvedValue(
        present ? { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } : null
      ),
  }) as unknown as R2Bucket;

const photos = [{ key: "inbound-attachments/g1/0-a.jpg", name: "a.jpg" }];

async function seedEmail(db: Db, id = "ie1") {
  await db.insert(inboundEmails).values({
    id,
    receivedAt: new Date(),
    fromAddress: "john@pimboat.com",
    toAddress: "photos@meetmeatthefair.com",
    intent: "photo_intake",
    status: "received",
    attachmentCount: 1,
    flaggedForReview: 0,
    createdAt: new Date(),
  } as never);
}

describe("runBoothPipeline — the OPE-6 gate", () => {
  it("no-ops and SAYS SO when PHOTO_VISION_ENABLED is not 'true'", async () => {
    const { db } = createTestDb();
    const run = vi.fn();
    const env: BoothPipelineEnv = { AI: { run }, VENDOR_ASSETS: bucket() };
    const res = await runBoothPipeline(env, db as unknown as Db, "ie1", "e1", photos);
    expect(res.examined).toBe(0);
    expect(res.disabledReason).toContain("PHOTO_VISION_ENABLED");
    // The point of the gate: zero AI spend.
    expect(run).not.toHaveBeenCalled();
  });

  it("stays off for any value other than the exact string 'true'", async () => {
    const { db } = createTestDb();
    const run = vi.fn();
    for (const v of ["TRUE", "1", "yes", "", undefined]) {
      const env = {
        AI: { run },
        VENDOR_ASSETS: bucket(),
        PHOTO_VISION_ENABLED: v,
      } as BoothPipelineEnv;
      const res = await runBoothPipeline(env, db as unknown as Db, "ie1", "e1", photos);
      expect(res.disabledReason).toBeDefined();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a disabled reason when bindings are missing rather than silently doing nothing", async () => {
    const { db } = createTestDb();
    const res = await runBoothPipeline(
      { PHOTO_VISION_ENABLED: "true" },
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );
    expect(res.disabledReason).toContain("binding");
  });
});

describe("runBoothPipeline — enabled", () => {
  const enabled = (aiReply: unknown, r2 = bucket()): BoothPipelineEnv => ({
    AI: { run: vi.fn().mockResolvedValue(aiReply) },
    VENDOR_ASSETS: r2,
    PHOTO_VISION_ENABLED: "true",
  });

  it("stages an identified booth and flags the email for review", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    const res = await runBoothPipeline(enabled(reply()), db as unknown as Db, "ie1", "e1", photos);
    expect(res).toMatchObject({ examined: 1, staged: 1, skipped: 0 });
    expect(res.identifiedNames).toEqual(["Maple Hollow Farm"]);

    const rows = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, BOOTH_PROPOSED_ACTION));
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payloadJson as string);
    expect(payload).toMatchObject({
      event_id: "e1",
      business_name: "Maple Hollow Farm",
      would_auto_write: true, // confident → Milestone B WOULD have written it
    });

    const email = await db.select().from(inboundEmails).where(eq(inboundEmails.id, "ie1"));
    expect(email[0].flaggedForReview).toBe(1);
  });

  it("does NOT write any vendor or event link — Milestone A stages only", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    await runBoothPipeline(enabled(reply()), db as unknown as Db, "ie1", "e1", photos);
    // The whole safety claim of this milestone: nothing public was created.
    const { vendors, eventVendors } = await import("../src/schema.js");
    expect(await db.select().from(vendors)).toHaveLength(0);
    expect(await db.select().from(eventVendors)).toHaveLength(0);
  });

  it("records a low-confidence booth as staged, not would-auto-write", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    const res = await runBoothPipeline(
      enabled(reply({ confidence: 0.3 })),
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );
    expect(res.staged).toBe(1);
    const rows = await db.select().from(adminActions);
    const payload = JSON.parse(rows[0].payloadJson as string);
    expect(payload.would_auto_write).toBe(false);
    expect(payload.stage_reason).toContain("below");
  });

  it("skips general scenery — no staged row, no flag", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    const res = await runBoothPipeline(
      enabled(reply({ kind: "general" })),
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );
    expect(res).toMatchObject({ examined: 1, staged: 0, skipped: 1 });
    expect(await db.select().from(adminActions)).toHaveLength(0);
    const email = await db.select().from(inboundEmails).where(eq(inboundEmails.id, "ie1"));
    expect(email[0].flaggedForReview).toBe(0);
  });

  it("survives an unreadable photo (missing from R2) without throwing", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    const res = await runBoothPipeline(
      enabled(reply(), bucket(false)),
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );
    expect(res.examined).toBe(0);
    expect(res.staged).toBe(0);
  });

  it("stages an unusable model reply for review rather than dropping it", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    const res = await runBoothPipeline(
      enabled({ response: "I can't tell" }),
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );
    // UNIDENTIFIED → kind "unclear" → staged, not silently skipped.
    expect(res.staged).toBe(1);
  });
});

// OPE-204 Milestone B — the auto-write routing. Gate is INDEPENDENT of vision.
describe("runBoothPipeline — auto-write (Milestone B)", () => {
  const enabledAW = (aiReply: unknown): BoothPipelineEnv => ({
    AI: { run: vi.fn().mockResolvedValue(aiReply) },
    VENDOR_ASSETS: bucket(),
    PHOTO_VISION_ENABLED: "true",
    PHOTO_AUTOWRITE_ENABLED: "true",
    // No MAIN_APP_URL → hero-if-blank no-ops; the write itself still runs.
  });

  async function seedEventE1(db: Db) {
    const { promoters, events } = await import("../src/schema.js");
    await db
      .insert(promoters)
      .values({ id: "p1", companyName: "P", slug: "p" } as never)
      .run?.();
    await db.insert(events).values({
      id: "e1",
      name: "Cumberland Fair",
      slug: "cumberland-fair",
      promoterId: "p1",
      status: "APPROVED",
    } as never);
  }

  it("with vision ON but auto-write OFF, a high-confidence booth STAGES (identify-only)", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    // reply() is confidence 0.9 → "write" disposition, but auto-write is off.
    const env: BoothPipelineEnv = {
      AI: { run: vi.fn().mockResolvedValue(reply()) },
      VENDOR_ASSETS: bucket(),
      PHOTO_VISION_ENABLED: "true",
    };
    const res = await runBoothPipeline(env, db as unknown as Db, "ie1", "e1", photos);
    expect(res.staged).toBe(1);
    expect(res.autoWritten).toEqual([]);
  });

  it("with auto-write ON, a high-confidence booth AUTO-WRITES and does NOT stage", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    await seedEventE1(db as unknown as Db);
    const res = await runBoothPipeline(
      enabledAW(reply()),
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );

    expect(res.autoWritten).toHaveLength(1);
    expect(res.autoWritten[0].wasCreated).toBe(true);
    // It was auto-written, so it is NOT in the review queue.
    expect(res.staged).toBe(0);
    const proposals = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, BOOTH_PROPOSED_ACTION))
      .all();
    expect(proposals).toHaveLength(0);
  });

  it("with auto-write ON, a LOW-confidence booth still STAGES, not written", async () => {
    const { db } = createTestDb();
    await seedEmail(db as unknown as Db);
    await seedEventE1(db as unknown as Db);
    const res = await runBoothPipeline(
      enabledAW(reply({ confidence: 0.4 })),
      db as unknown as Db,
      "ie1",
      "e1",
      photos
    );
    expect(res.autoWritten).toEqual([]);
    expect(res.staged).toBe(1); // banner-behind-another-booth safety preserved
  });
});
