/**
 * OPE-978 — every photo that comes in has a recorded outcome, and one that
 * does not is named. Includes the 2026-09-12 New Gloucester batch, reconstructed
 * from its measured prod shape: 20 emails, 18 staged proposals, and two photos
 * the classifier called scenery (photos_stored 1, no decision row).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { adminActions, inboundEmails } from "../src/schema.js";
import { computeIntakeAccounting } from "../src/photo/intake-accounting.js";
import {
  BOOTH_PROPOSED_ACTION,
  GALLERY_ATTACHED_ACTION,
  runBoothPipeline,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import type { Db } from "../src/db.js";

vi.mock("../src/photo/general-photos.js", () => ({
  attachGeneralPhotos: async (_env: unknown, _eventId: string, photos: unknown[]) => ({
    attached: photos.length,
    failed: 0,
  }),
}));

const EVENT = "4fde2cf7-9298-4b8d-b32f-36b79c376ad0";
const DAY = new Date("2026-09-12T15:00:00Z");
let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
});

function email(id: string, over: Record<string, unknown> = {}) {
  db.insert(inboundEmails)
    .values({
      id,
      receivedAt: DAY,
      fromAddress: "jtarboxme@gmail.com",
      toAddress: "submit@meetmeatthefair.com",
      intent: "photo_intake",
      status: "replied",
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        {
          key: `inbound-attachments/${id}/0-IMG.jpg`,
          name: "IMG.jpg",
          mimeType: "image/jpeg",
          size: 3_700_161,
        },
      ]),
      resultingEventId: EVENT,
      flaggedForReview: 0,
      createdAt: DAY,
      ...over,
    } as never)
    .run();
}
function decision(emailId: string, action = BOOTH_PROPOSED_ACTION) {
  db.insert(adminActions)
    .values({
      action,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: emailId,
      payloadJson: JSON.stringify({
        event_id: EVENT,
        photo_key: `inbound-attachments/${emailId}/0-IMG.jpg`,
      }),
      createdAt: DAY,
    } as never)
    .run();
}
const acct = () =>
  computeIntakeAccounting(
    db as unknown as Db,
    new Date("2026-09-12T00:00:00Z"),
    new Date("2026-09-13T00:00:00Z")
  );

describe("OPE-978 — intake accounting", () => {
  it("ACCEPTANCE: the 2026-09-12 batch reconciles — 20 in, 18 proposed, 2 gallery, 0 unaccounted", async () => {
    for (let i = 0; i < 18; i++) {
      email(`p${i}`, { photosStored: 0 });
      decision(`p${i}`);
    }
    // 03dec707 and 65df24a9: classified scenery, attached, no decision row then.
    email("03dec707", { photosStored: 1 });
    email("65df24a9", { photosStored: 1 });
    const a = await acct();
    expect(a).toMatchObject({
      emails_in: 20,
      photos_in: 20,
      unaccounted_count: 0,
      gallery_legacy_count: 2,
    });
    expect(a.outcomes.booth_proposed).toBe(18);
  });

  it("ACCEPTANCE: a photo stored with NO outcome and NO failure is counted and named", async () => {
    email("lost-1", { photosStored: null });
    const a = await acct();
    expect(a.unaccounted_count).toBe(1);
    expect(a.unaccounted[0]).toMatchObject({
      inbound_email_id: "lost-1",
      photo_name: "IMG.jpg",
      email_status: "replied",
    });
  });

  it("held (fair never resolved) is its own count, not 'unaccounted'", async () => {
    email("held-1", { resultingEventId: null });
    const a = await acct();
    expect(a).toMatchObject({ emails_held_unmatched: 1, unaccounted_count: 0 });
  });

  it("a scenery photo through the pipeline now leaves a gallery decision row the accounting reads", async () => {
    email("new-scenery", { photosStored: null });
    const env: BoothPipelineEnv = {
      AI: {
        run: vi.fn().mockResolvedValue({
          response: { kind: "scenery", name: null, confidence: 1, identifiable_minor: false },
        }),
      },
      VENDOR_ASSETS: {
        get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
      } as unknown as R2Bucket,
      PHOTO_VISION_ENABLED: "true",
    };
    await runBoothPipeline(env, db as unknown as Db, "new-scenery", EVENT, [
      { key: "inbound-attachments/new-scenery/0-IMG.jpg", name: "IMG.jpg" },
    ]);
    const a = await acct();
    expect(a.outcomes.gallery_attached).toBe(1);
    expect(a.gallery_legacy_count).toBe(0);
    expect(a.unaccounted_count).toBe(0);
  });

  it("a legacy photos_stored count never double-counts a photo that has a row", async () => {
    email("mixed", { photosStored: 1 });
    decision("mixed", GALLERY_ATTACHED_ACTION);
    const a = await acct();
    expect(a).toMatchObject({ gallery_legacy_count: 0, unaccounted_count: 0 });
    expect(a.outcomes.gallery_attached).toBe(1);
  });
});
