/**
 * OPE-240 — booth / not-booth, John's ruling 2026-09-30: no auto-write until a
 * photo has to show a vendor's stall, not just a legible sign.
 *
 * Specimens (Farmington Fair, 2026-09-26), both read as booths at confidence
 * 1.0 by the main prompt: a wall banner advertising "50th Annual Chester
 * Greenwood Day", and the fair's own "AGRICULTURAL MUSEUM" barn. The separate
 * presence question answered `building_or_wall` for both, on both runs.
 */
import { describe, it, expect, vi } from "vitest";
import {
  applyPresenceGate,
  parsePresenceReply,
  presencePrompt,
  disposition,
  SIGN_MOUNTS,
  type BoothIdentification,
} from "../src/photo/vision.js";
import {
  runBoothPipeline,
  BOOTH_PROPOSED_ACTION,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import { createTestDb } from "./setup-db.js";
import type { Db } from "../src/db.js";
import { adminActions, inboundEmails } from "../src/schema.js";
import { eq } from "drizzle-orm";

const booth = (over: Partial<BoothIdentification> = {}): BoothIdentification => ({
  kind: "booth",
  businessName: "50th Annual Chester Greenwood Day",
  performerName: null,
  signText: null,
  website: null,
  products: [],
  confidence: 1,
  rationale: "Legible sign with clear text and no obstructions",
  identifiableMinor: false,
  ...over,
});

describe("applyPresenceGate", () => {
  it("the specimen would WRITE without the gate — the gate is what stops it", () => {
    expect(disposition(booth()).action).toBe("write");
  });

  it("a sign on a building or wall stages (the Chester Greenwood banner, the museum barn)", () => {
    const d = applyPresenceGate(disposition(booth()), "building_or_wall");
    expect(d).toMatchObject({ action: "stage", stageKind: "booth_not_at_a_stall" });
    expect(d.identification.mountedOn).toBe("building_or_wall");
  });

  it("only vendor_table_or_tent keeps it a write — every other mount stages", () => {
    for (const m of SIGN_MOUNTS) {
      const d = applyPresenceGate(disposition(booth()), m);
      expect(d.action).toBe(m === "vendor_table_or_tent" ? "write" : "stage");
    }
  });

  it("no answer stages — an unanswered question does not publish", () => {
    const d = applyPresenceGate(disposition(booth()), null);
    expect(d).toMatchObject({ action: "stage", stageKind: "booth_not_at_a_stall" });
    if (d.action === "stage") expect(d.reason).toContain("not answered");
  });

  it("does nothing to a photo that was not going to write", () => {
    const staged = disposition(booth({ confidence: 0.5 }));
    expect(applyPresenceGate(staged, "building_or_wall")).toBe(staged);
  });
});

describe("parsePresenceReply", () => {
  it("reads the object Workers AI returns", () => {
    expect(parsePresenceReply({ response: { mounted_on: "building_or_wall" } })).toBe(
      "building_or_wall"
    );
  });

  it("reads a string reply with JSON inside prose", () => {
    expect(parsePresenceReply({ response: 'Sure: {"mounted_on":"vendor_table_or_tent"}' })).toBe(
      "vendor_table_or_tent"
    );
  });

  it("anything outside the closed vocabulary is null", () => {
    for (const raw of [
      { response: { mounted_on: "a table" } },
      { response: { mounted_on: "VENDOR_TABLE_OR_TENT" } },
      { response: { booth: true } },
      { response: "a table" },
      null,
    ]) {
      expect(parsePresenceReply(raw)).toBeNull();
    }
  });

  it("the prompt names the sign it asks about", () => {
    expect(presencePrompt("AGRICULTURAL MUSEUM")).toContain('"AGRICULTURAL MUSEUM"');
  });
});

describe("runBoothPipeline — the presence gate with auto-write ON", () => {
  const photos = [{ key: "inbound-attachments/g1/0-a.jpg", name: "a.jpg" }];
  const bucket = {
    get: vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
  } as unknown as R2Bucket;
  const boothReply = {
    kind: "booth",
    name: "50th Annual Chester Greenwood Day",
    website: null,
    products: [],
    confidence: 1,
    rationale: "Legible sign",
    identifiable_minor: false,
  };

  async function run(presence: unknown) {
    const { db } = createTestDb();
    await db.insert(inboundEmails).values({
      id: "ie1",
      receivedAt: new Date(),
      fromAddress: "john@pimboat.com",
      toAddress: "photos@meetmeatthefair.com",
      intent: "photo_intake",
      status: "received",
      attachmentCount: 1,
      flaggedForReview: 0,
      createdAt: new Date(),
    } as never);
    const ai = vi.fn().mockResolvedValueOnce({ response: boothReply });
    ai.mockResolvedValueOnce(presence);
    const env: BoothPipelineEnv = {
      AI: { run: ai },
      VENDOR_ASSETS: bucket,
      PHOTO_VISION_ENABLED: "true",
      PHOTO_AUTOWRITE_ENABLED: "true",
    };
    const res = await runBoothPipeline(env, db as unknown as Db, "ie1", "e1", photos);
    const rows = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, BOOTH_PROPOSED_ACTION));
    return {
      res,
      ai,
      payloads: rows.map((r) => JSON.parse(r.payloadJson ?? "{}") as Record<string, unknown>),
    };
  }

  it("a banner on a wall is staged, not written, and the answer is recorded", async () => {
    const { res, ai, payloads } = await run({ response: { mounted_on: "building_or_wall" } });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(String(ai.mock.calls[1][1].prompt)).toContain("physically attached");
    expect(res.autoWritten).toEqual([]);
    expect(payloads).toMatchObject([
      {
        stage_kind: "booth_not_at_a_stall",
        sign_mounted_on: "building_or_wall",
        would_auto_write: false,
      },
    ]);
  });

  it("a failed presence call stages too", async () => {
    const { res, payloads } = await run(undefined);
    expect(res.autoWritten).toEqual([]);
    expect(payloads).toMatchObject([{ stage_kind: "booth_not_at_a_stall", sign_mounted_on: null }]);
  });
});
