/**
 * OPE-1709 — the first real Snap business card (2026-11-25)
 * was held as "which fair?". Measured with the production prompt: the main
 * vision prompt reads a card as a BOOTH (6 of 6, upright and sideways), so the
 * event-less "cards only?" pass counted it as `notCards: 1` and fell through to
 * the hold — and no step recorded why.
 *
 * The fix asks a separate main-subject question of booth / signage / unclear
 * reads. These tests drive the model with the replies it actually gave:
 *   - main prompt  → kind "booth", name "Birch Hollow Woodworks", confidence 1
 *   - card check   → "business_card"
 * and check the routing (handler), the write rules (pipeline) and the evidence
 * (workflow step), plus the landmarks that keep it from turning booths into cards.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";

vi.mock("../src/db.js", () => ({ getDb: (d: unknown) => d }));

import {
  adminActions,
  events,
  inboundEmails,
  promoters,
  vendors,
  workflowRunSteps,
} from "../src/schema.js";
import {
  BOOTH_PROPOSED_ACTION,
  runBoothPipeline,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import {
  CARDS_ONLY_STEP,
  PHOTO_CLASSIFY_STEP,
  handle,
} from "../src/email-handlers/photo-intake.js";
import {
  applyCardCheck,
  CARD_SUBJECT_PROMPT,
  needsCardCheck,
  parseCardSubjectReply,
  UNIDENTIFIED,
  type BoothIdentification,
  type CardSubject,
} from "../src/photo/vision.js";
import { SNAP_ROUTING_SOURCE, type CaptureMeta } from "../src/photo/snap-intake.js";
import type { Db } from "../src/db.js";

const f = (value: unknown, confidence = 1) => ({ value, confidence });

// The shape the model returned for the real card (fictional values; business-card read).
const cardRead = {
  response: {
    business_name: f("Birch Hollow Woodworks"),
    contact_name: f("Sam Rivera"),
    phone: f(null),
    email: f("owner@birchhollowwoodworks.example"),
    website: f("birchhollowwoodworks.example"),
    social: f([]),
    street: f(null),
    city: f(null),
    state: f(null),
    zip: f(null),
  },
};
// The shape the MAIN prompt returned for it, 6 of 6 runs (fictional values).
const mainRead = {
  response: {
    kind: "booth",
    name: "Birch Hollow Woodworks",
    website: "birchhollowwoodworks.example",
    products: ["custom woodworking"],
    confidence: 1,
    rationale: "clear sign with visible text and logo",
    identifiable_minor: false,
  },
};

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "ev1", name: "CMP Fair", slug: "cmp-fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

/** A model fake that answers by prompt, and records which prompts it was asked. */
function env(subject: CardSubject | "no-answer", autoWrite = "true") {
  const asked: string[] = [];
  const e: BoothPipelineEnv & { DB: unknown } = {
    AI: {
      run: async (_m: string, input: { prompt?: string }) => {
        const p = String(input?.prompt ?? "");
        if (p.includes("main_subject")) {
          asked.push("card-check");
          return subject === "no-answer"
            ? { response: "I cannot tell." }
            : { response: { main_subject: subject } };
        }
        if (p.includes("BUSINESS CARD")) {
          asked.push("card-read");
          return cardRead;
        }
        if (p.includes("physically attached")) {
          asked.push("presence");
          return { response: { mounted_on: "vendor_table_or_tent" } };
        }
        asked.push("main");
        return mainRead;
      },
    },
    VENDOR_ASSETS: {
      get: async () => ({
        arrayBuffer: async () => new Uint8Array([1]).buffer,
        httpMetadata: { contentType: "image/jpeg" },
      }),
    } as unknown as R2Bucket,
    PHOTO_VISION_ENABLED: "true",
    PHOTO_AUTOWRITE_ENABLED: autoWrite,
    DB: db,
  };
  return { e, asked };
}
const photos = [{ key: "inbound-attachments/snap-x/0-card.jpg", name: "0-card.jpg" }];
const vendorByName = (name: string) =>
  db.select().from(vendors).where(eq(vendors.businessName, name)).all();
const steps = () => db.select().from(workflowRunSteps).all();
const detail = (s: { detail: string | null }) => JSON.parse(s.detail ?? "{}");

// ─── The pure pieces ────────────────────────────────────────────────────────

describe("card-subject check — parse, when asked, how applied", () => {
  const booth: BoothIdentification = {
    ...UNIDENTIFIED,
    kind: "booth",
    businessName: "Birch Hollow Woodworks",
    website: "birchhollowwoodworks.example",
    products: ["custom woodworking"],
    confidence: 1,
    rationale: "",
  };

  it("parses only an exact enum value", () => {
    expect(parseCardSubjectReply({ response: { main_subject: "business_card" } })).toBe(
      "business_card"
    );
    expect(parseCardSubjectReply({ response: '{"main_subject":"booth_or_table"}' })).toBe(
      "booth_or_table"
    );
    expect(parseCardSubjectReply({ response: { main_subject: "card" } })).toBeNull();
    expect(parseCardSubjectReply({ response: "a business card" })).toBeNull();
    expect(CARD_SUBJECT_PROMPT).toContain("even if small cards lie on it");
  });

  it("asks booth / signage / unclear reads; never a salvaged, performer, scenery or card read", () => {
    expect(needsCardCheck(booth)).toBe(true);
    expect(needsCardCheck({ ...booth, kind: "signage" })).toBe(true);
    expect(needsCardCheck(UNIDENTIFIED)).toBe(true);
    expect(needsCardCheck({ ...booth, salvaged: "markdown" })).toBe(false);
    expect(needsCardCheck({ ...booth, kind: "performer" })).toBe(false);
    expect(needsCardCheck({ ...booth, kind: "scenery" })).toBe(false);
    expect(needsCardCheck({ ...booth, kind: "business_card" })).toBe(false);
  });

  it("only 'business_card' changes the kind; any other answer, or none, leaves it a booth", () => {
    const card = applyCardCheck(booth, "business_card");
    expect(card).toMatchObject({
      kind: "business_card",
      businessName: "Birch Hollow Woodworks",
      reclassifiedFrom: "booth",
      cardCheck: "business_card",
      website: null,
      products: [],
    });
    for (const s of ["booth_or_table", "banner_or_sign", "other", null] as const) {
      const kept = applyCardCheck(booth, s);
      expect(kept.kind).toBe("booth");
      expect(kept.cardCheck).toBe(s);
      expect(kept.reclassifiedFrom).toBeUndefined();
    }
  });

  it("a signage read that is really a card keeps the sign text as the card's name", () => {
    const sign = {
      ...booth,
      kind: "signage" as const,
      businessName: null,
      signText: "Juniper Lane Knits",
    };
    expect(applyCardCheck(sign, "business_card")).toMatchObject({
      kind: "business_card",
      businessName: "Juniper Lane Knits",
      signText: null,
    });
  });
});

// ─── The pipeline ───────────────────────────────────────────────────────────

describe("runBoothPipeline — a card the main prompt calls a booth", () => {
  it("event-less: handled as a card (not notCards), and the classification says why", async () => {
    const { e, asked } = env("business_card");
    const res = await runBoothPipeline(e, db as unknown as Db, "ie1", null, photos, {
      cardIntent: { addAsVendor: false, metAtEventId: null },
    });
    expect(asked).toEqual(["main", "card-check", "card-read"]);
    expect(res.notCards ?? 0).toBe(0);
    expect(res.cardsHandled).toBe(1);
    expect(res.classifications).toEqual([
      expect.objectContaining({
        kind: "business_card",
        action: "card",
        cardCheck: "business_card",
        reclassifiedFrom: "booth",
      }),
    ]);
  });

  it("at a fair with auto-write ON: the card is never published as a booth, and the presence gate is not asked", async () => {
    const { e, asked } = env("business_card");
    const res = await runBoothPipeline(e, db as unknown as Db, "ie1", "ev1", photos);
    expect(asked).not.toContain("presence");
    expect(res.autoWritten).toEqual([]);
    const booths = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, BOOTH_PROPOSED_ACTION))
      .all();
    expect(booths).toEqual([]);
    expect(res.cardsHandled).toBe(1);
  });

  it("LANDMARK — a booth the card check calls a booth still auto-writes (the gate is live)", async () => {
    const { e, asked } = env("booth_or_table");
    const res = await runBoothPipeline(e, db as unknown as Db, "ie1", "ev1", photos);
    expect(asked).toEqual(["main", "card-check", "presence"]);
    expect(res.autoWritten.map((a) => a.businessName)).toEqual(["Birch Hollow Woodworks"]);
    expect(res.classifications?.[0]).toMatchObject({ kind: "booth", cardCheck: "booth_or_table" });
  });

  it("an unanswered card check changes nothing: the booth path runs as before", async () => {
    const { e } = env("no-answer");
    const res = await runBoothPipeline(e, db as unknown as Db, "ie1", "ev1", photos);
    expect(res.autoWritten).toHaveLength(1);
    expect(res.classifications?.[0]).toMatchObject({ kind: "booth", cardCheck: null });
  });
});

// ─── The handler: routing + the workflow step ───────────────────────────────

const ROW = "snap-b1a08cb3-0000-0000-0000-000000000000";
function seedRow(meta: Partial<CaptureMeta>) {
  const captureMeta: CaptureMeta = {
    client_id: "b1a08cb3-0000-0000-0000-000000000000",
    captured_at: "2026-11-25T15:05:06Z",
    location: { latitude: 44.82, longitude: -70.34, accuracy_m: 9 },
    location_source: "device",
    taken_on_local_date: "2026-11-25",
    event_id: null,
    event_slug: null,
    note: null,
    actor: "admin@example.test",
    ...meta,
  };
  db.insert(inboundEmails)
    .values({
      id: ROW,
      receivedAt: new Date("2026-11-25T15:05:07Z"),
      fromAddress: "admin@example.test",
      toAddress: "photos@meetmeatthefair.com",
      subject: null,
      intent: "photo_intake",
      status: "processing",
      attachmentCount: 1,
      attachmentRefs: JSON.stringify([
        { key: photos[0].key, name: photos[0].name, mimeType: "image/jpeg", size: 1 },
      ]),
      routingSource: SNAP_ROUTING_SOURCE,
      captureMeta: JSON.stringify(captureMeta),
      createdAt: new Date("2026-11-25T15:05:07Z"),
    } as never)
    .run();
  return db.select().from(inboundEmails).where(eq(inboundEmails.id, ROW)).get()!;
}
const ctx = { sessionId: "wf-1709", senderTrust: "trusted", emailAuth: "pass" } as never;

describe("photo-intake handler — the 2026-11-25 card, replayed", () => {
  it("'No fair' + 'Add as vendor': not held; the vendor is created; the step records the verdict", async () => {
    const { e } = env("business_card");
    const res = await handle(
      e as never,
      ctx,
      seedRow({ no_fair: true, add_as_vendor: true }) as never
    );
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.replyParams).toMatchObject({ cardsOnly: true, cardsCreated: 1 });
    expect(vendorByName("Birch Hollow Woodworks")).toHaveLength(1);

    const s = steps();
    expect(s.map((x) => [x.stepName, x.status, x.instanceId])).toEqual([
      [CARDS_ONLY_STEP, "ok", "wf-1709"],
    ]);
    expect(detail(s[0])).toMatchObject({
      pass: "no-fair",
      verdict: "all-cards",
      photos: [{ kind: "business_card", cardCheck: "business_card", reclassifiedFrom: "booth" }],
    });
  });

  it("LANDMARK — a real booth under 'No fair' is still held, and every pass leaves a step saying so", async () => {
    const { e } = env("booth_or_table");
    const res = await handle(e as never, ctx, seedRow({ no_fair: true }) as never);
    expect(res.replyKind).toBe("photo-intake-unresolved");
    const s = steps();
    expect(s.map((x) => x.stepName)).toEqual([CARDS_ONLY_STEP]);
    expect(detail(s[0])).toMatchObject({
      verdict: "not-only-cards",
      notCards: 1,
      photos: [{ kind: "booth", cardCheck: "booth_or_table", action: expect.any(String) }],
    });
    expect(PHOTO_CLASSIFY_STEP).toBe("photo/classify");
  });

  it("vision off: the step is recorded as skipped, with the reason", async () => {
    const { e } = env("business_card");
    e.PHOTO_VISION_ENABLED = "false";
    await handle(e as never, ctx, seedRow({ no_fair: true }) as never);
    const s = steps();
    expect(s[0]).toMatchObject({ stepName: CARDS_ONLY_STEP, status: "skipped" });
    expect(detail(s[0]).verdict).toBe("vision-off");
  });
});
