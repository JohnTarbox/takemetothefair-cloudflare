/**
 * OPE-1705 slice 2 — a business card paired with the booth shot just before it.
 *
 * Each Snap shot is its own inbound row and Workflow run, so the pairing is
 * driven from both sides: the card's run looks back, the booth's run looks
 * forward. These tests run the REAL pipeline for whichever side is under test
 * and seed the other side's rows as the pipeline itself writes them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  adminActions,
  eventVendors,
  events,
  inboundEmails,
  promoters,
  users,
  vendors,
  vendorEnrichmentCandidates,
} from "../src/schema.js";
import {
  BOOTH_PROPOSED_ACTION,
  CARD_APPLIED_ACTION,
  CARD_PROPOSED_ACTION,
  runBoothPipeline,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import { BOOTH_AUTOWRITTEN_ACTION } from "../src/photo/auto-write.js";
import {
  CARD_PAIRED_ACTION,
  classifyPairing,
  pairName,
  pairWindowMs,
  photoIndex,
} from "../src/photo/card-pairing.js";
import { PHOTO_RESOLVED_ACTION } from "../src/photo/repoint.js";
import { reviewPhotoProposal } from "../src/photo/review-proposal.js";
import type { CardReading } from "../src/photo/business-card.js";
import type { Db } from "../src/db.js";

const f = (value: unknown, confidence = 1) => ({ value, confidence });
const JOHN = "admin@example.test";
const T0 = Date.parse("2026-08-15T14:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

let db: TestDb;
const asDb = () => db as unknown as Db;

function seedVendor(id: string, businessName: string, extra: Record<string, unknown> = {}) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id, ...extra } as never)
    .run();
}
/** An inbound row as snap-intake writes it. `min` = minutes after T0 at the shutter. */
function seedRow(id: string, min: number, uploader = JOHN) {
  db.insert(inboundEmails)
    .values({
      id,
      receivedAt: new Date(T0 + min * 60_000 + 5_000),
      fromAddress: uploader,
      toAddress: "photos+cmp-fair@meetmeatthefair.com",
      intent: "photo_intake",
      status: "received",
      attachmentCount: 1,
      rawSize: 1,
      routingSource: "snap-app",
      captureMeta: JSON.stringify({ client_id: id, captured_at: at(min), actor: uploader }),
      createdAt: new Date(T0),
    } as never)
    .run();
}
/** A booth decision row, exactly the shape booth-pipeline / auto-write record. */
function seedBooth(
  rowId: string,
  action: string,
  payload: Record<string, unknown>,
  id = `act-${rowId}`
) {
  db.insert(adminActions)
    .values({
      id,
      action,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: rowId,
      payloadJson: JSON.stringify({
        event_id: "ev1",
        photo_key: `inbound-attachments/${rowId}/0-booth.jpg`,
        photo_name: "0-booth.jpg",
        ...(action === BOOTH_PROPOSED_ACTION ? { photo_class: "booth" } : {}),
        ...payload,
      }),
      createdAt: new Date(T0),
    } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "ev1", name: "CMP Fair", slug: "cmp-fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

const cardReply = (over: Record<string, unknown> = {}) => ({
  response: {
    business_name: f("Fern Hollow"),
    contact_name: f("Jane Doe"),
    phone: f("207-555-0123"),
    email: f("jane@fernhollow.com"),
    website: f("fernhollow.com"),
    social: f([]),
    street: f(null),
    city: f("Gray"),
    state: f("ME"),
    zip: f(null),
    ...over,
  },
});
/** The vision mock: a card when asked about a card; otherwise `main` (default: a card). */
const env = (
  card: unknown,
  opts: { autoWrite?: string; main?: Record<string, unknown>; window?: string } = {}
): BoothPipelineEnv => ({
  AI: {
    run: async (_m: string, input: { prompt: string }) =>
      input.prompt.includes("BUSINESS CARD")
        ? card
        : {
            response: opts.main ?? {
              kind: "business_card",
              name: "Fern Hollow",
              website: null,
              products: [],
              confidence: 1,
              rationale: "a card",
              identifiable_minor: false,
            },
          },
  },
  VENDOR_ASSETS: {
    get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
  } as unknown as R2Bucket,
  PHOTO_VISION_ENABLED: "true",
  PHOTO_AUTOWRITE_ENABLED: opts.autoWrite ?? "true",
  CARD_PAIR_WINDOW_MINUTES: opts.window,
});
const shot = (rowId: string, name = "card.jpg") => [
  { key: `inbound-attachments/${rowId}/0-${name}`, name: `0-${name}` },
];
const runCard = (rowId: string, e: BoothPipelineEnv = env(cardReply())) =>
  runBoothPipeline(e, asDb(), rowId, "ev1", shot(rowId));
const rows = (action: string) =>
  db
    .select()
    .from(adminActions)
    .all()
    .filter((a) => a.action === action);
const pairedPayloads = () => rows(CARD_PAIRED_ACTION).map((a) => JSON.parse(a.payloadJson!));
const vendorRow = (id: string) => db.select().from(vendors).where(eq(vendors.id, id)).get()!;

describe("classifyPairing — does the card agree with the booth?", () => {
  const card = (c: CardReading, vendorId: string | null = null) => ({ card: c, vendorId });
  const booth = (b: Partial<Parameters<typeof classifyPairing>[1]> = {}) => ({
    businessName: null,
    website: null,
    stageKind: null,
    vendorId: null,
    ...b,
  });
  const fern: CardReading = {
    businessName: { value: "Fern Hollow", confidence: 1 },
    website: { value: "www.FernHollow.com", confidence: 1 },
  };

  it("same matched vendor → confirmed by vendor", () => {
    expect(classifyPairing(card(fern, "v1"), booth({ vendorId: "v1" }))).toEqual({
      kind: "confirmed",
      basis: "vendor",
    });
  });
  it("card website host = booth website host → confirmed by domain", () => {
    expect(classifyPairing(card(fern), booth({ website: "https://fernhollow.com/shop" }))).toEqual({
      kind: "confirmed",
      basis: "domain",
    });
  });
  it("card email host counts as its domain", () => {
    const c: CardReading = { email: { value: "jane@fernhollow.com", confidence: 1 } };
    expect(classifyPairing(card(c), booth({ website: "fernhollow.com" })).basis).toBe("domain");
  });
  it("same name modulo case, punctuation and & → confirmed by name", () => {
    const c: CardReading = { businessName: { value: "Fern & Hollow", confidence: 1 } };
    expect(classifyPairing(card(c), booth({ businessName: "FERN AND HOLLOW!" }))).toEqual({
      kind: "confirmed",
      basis: "name",
    });
  });
  it("an unreadable booth + a legible card name → unreadable_booth", () => {
    expect(classifyPairing(card(fern), booth({ stageKind: "booth_name_unreadable" })).kind).toBe(
      "unreadable_booth"
    );
  });
  it("an unreadable booth + an unreadable card → order only", () => {
    const c: CardReading = { businessName: { value: "Fern Hollow", confidence: 0.5 } };
    expect(classifyPairing(card(c), booth({ stageKind: "booth_name_unreadable" })).kind).toBe(
      "order_only"
    );
  });
  it("different names, no shared domain → order only", () => {
    expect(classifyPairing(card(fern), booth({ businessName: "Bay State Bath" })).kind).toBe(
      "order_only"
    );
  });
  it("the action strings card-pairing mirrors match their sources", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/photo/card-pairing.ts", import.meta.url), "utf8")
    );
    expect(src).toContain(`const PHOTO_RESOLVED_ACTION = "${PHOTO_RESOLVED_ACTION}";`);
    expect(src).toContain(`const BOOTH_PROPOSED = "${BOOTH_PROPOSED_ACTION}";`);
    expect(src).toContain(`const CARD_PROPOSED = "${CARD_PROPOSED_ACTION}";`);
    expect(src).toContain(`const CARD_APPLIED = "${CARD_APPLIED_ACTION}";`);
    expect(src).not.toMatch(/from "\.\/(repoint|booth-pipeline)\.js"/);
  });

  it("helpers", () => {
    expect(pairName("Fern & Hollow, LLC")).toBe("fernandhollowllc");
    expect(photoIndex("inbound-attachments/ie1/3-x.jpg")).toBe(3);
    expect(pairWindowMs({})).toBe(10 * 60_000);
    expect(pairWindowMs({ CARD_PAIR_WINDOW_MINUTES: "15" })).toBe(15 * 60_000);
    expect(pairWindowMs({ CARD_PAIR_WINDOW_MINUTES: "9999" })).toBe(10 * 60_000);
  });
});

describe("card run looks BACK for its booth", () => {
  it("booth auto-wrote a vendor; the card's name matches the booth → card fields go to that vendor", async () => {
    // The booth fuzzy-linked a vendor whose stored name differs, so the card
    // does NOT match it on its own — only the pairing can find it.
    seedVendor("v1", "Fern Hollow Pottery LLC");
    seedRow("snap-booth", 0);
    seedBooth("snap-booth", BOOTH_AUTOWRITTEN_ACTION, {
      vendor_id: "v1",
      business_name: "Fern Hollow",
    });
    seedRow("snap-card", 1);

    const res = await runCard("snap-card");

    expect(res.cardPairings).toEqual([
      expect.objectContaining({
        pairing: "confirmed",
        basis: "name",
        effect: "card_applied_to_booth_vendor",
        vendorId: "v1",
      }),
    ]);
    const v = vendorRow("v1");
    expect([v.website, v.city, v.state]).toEqual(["fernhollow.com", "Gray", "ME"]);
    // Ruling (a) still holds through the pairing: contacts are staged, not written.
    expect([v.contactEmail, v.contactPhone, v.contactName]).toEqual([null, null, null]);
    const staged = db.select().from(vendorEnrichmentCandidates).all();
    expect(staged.map((c) => c.proposedField).sort()).toEqual(
      ["contact_email", "contact_name", "contact_phone"].sort()
    );
    expect(staged.every((c) => c.vendorId === "v1")).toBe(true);
    expect(v.logoUrl ?? null).toBeNull(); // the card is never an image
  });

  it("a booth staged only for lack of corroboration is WRITTEN once its card supplies the web address", async () => {
    seedRow("snap-booth", 0);
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, {
      business_name: "Fern Hollow",
      website: null,
      products: [],
      stage_kind: "booth_new_vendor_uncorroborated",
    });
    seedRow("snap-card", 2);

    const res = await runCard("snap-card");

    expect(res.cardPairings?.[0]).toMatchObject({
      pairing: "confirmed",
      basis: "name",
      effect: "booth_written_from_card",
    });
    const vendorId = res.cardPairings![0].vendorId!;
    const v = vendorRow(vendorId);
    expect(v.businessName).toBe("Fern Hollow");
    expect(v.website).toBe("fernhollow.com");
    expect([v.city, v.state]).toEqual(["Gray", "ME"]);
    // Linked to the event as a confirmed exhibitor — the booth's own write tail.
    const link = db.select().from(eventVendors).all();
    expect(link).toEqual([
      expect.objectContaining({ eventId: "ev1", vendorId, status: "CONFIRMED" }),
    ]);
    // The booth proposal is closed, so it no longer reads as open.
    const [resolved] = rows(PHOTO_RESOLVED_ACTION);
    expect(resolved.targetId).toBe("act-snap-booth");
    expect(JSON.parse(resolved.payloadJson!)).toMatchObject({
      resolution: "approved",
      vendor_id: vendorId,
      via: "card_pairing",
    });
  });

  it("…but not with auto-write OFF: recorded, nothing created", async () => {
    seedRow("snap-booth", 0);
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, {
      business_name: "Fern Hollow",
      stage_kind: "booth_new_vendor_uncorroborated",
    });
    seedRow("snap-card", 2);

    const res = await runCard("snap-card", env(cardReply(), { autoWrite: "false" }));

    expect(res.cardPairings?.[0]).toMatchObject({ pairing: "confirmed", effect: "recorded" });
    expect(db.select().from(vendors).all()).toEqual([]);
    expect(rows(PHOTO_RESOLVED_ACTION)).toEqual([]);
  });

  it("names differ → order only: recorded, nothing written", async () => {
    seedRow("snap-booth", 0);
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, {
      business_name: "Bay State Bath",
      stage_kind: "booth_new_vendor_uncorroborated",
    });
    seedRow("snap-card", 1);

    const res = await runCard("snap-card");

    expect(res.cardPairings?.[0]).toMatchObject({ pairing: "order_only", effect: "recorded" });
    expect(db.select().from(vendors).all()).toEqual([]);
    expect(res.cards?.proposed).toEqual([
      { businessName: "Fern Hollow", stageKind: "card_unmatched" },
    ]);
  });

  it("a booth outside the window is not this card's booth — unless the window is widened", async () => {
    seedRow("snap-booth", 0);
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, {
      business_name: "Fern Hollow",
      stage_kind: "booth_new_vendor_uncorroborated",
    });
    seedRow("snap-card", 11);
    expect((await runCard("snap-card")).cardPairings).toBeUndefined();
    expect(rows(CARD_PAIRED_ACTION)).toEqual([]);

    seedRow("snap-card2", 11);
    const wide = await runCard("snap-card2", env(cardReply(), { window: "15" }));
    expect(wide.cardPairings?.[0].pairing).toBe("confirmed");
  });

  it("a card shot BEFORE the booth is not paired with it from the card side", async () => {
    seedRow("snap-booth", 3);
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, { business_name: "Fern Hollow" });
    seedRow("snap-card", 1);
    expect((await runCard("snap-card")).cardPairings).toBeUndefined();
  });

  it("another uploader's booth is never paired", async () => {
    seedRow("snap-booth", 0, "someone-else@example.test");
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, { business_name: "Fern Hollow" });
    seedRow("snap-card", 1);
    expect((await runCard("snap-card")).cardPairings).toBeUndefined();
  });

  it("the NEAREST booth wins, and a booth already paired is not taken by a second card", async () => {
    seedRow("snap-b1", 0);
    seedBooth("snap-b1", BOOTH_PROPOSED_ACTION, { business_name: "Bay State Bath" });
    seedRow("snap-b2", 2);
    seedBooth("snap-b2", BOOTH_PROPOSED_ACTION, { business_name: "Fern Hollow" });
    seedRow("snap-card", 3);
    seedRow("snap-card2", 4);

    await runCard("snap-card");
    await runCard("snap-card2", env(cardReply({ business_name: f("Bay State Bath") })));

    const p = pairedPayloads();
    expect(p.map((x) => [x.card_email_id, x.booth_email_id, x.pairing])).toEqual([
      ["snap-card", "snap-b2", "confirmed"],
      ["snap-card2", "snap-b1", "confirmed"],
    ]);
  });

  it("a re-run of the card pairs once", async () => {
    seedRow("snap-booth", 0);
    seedBooth("snap-booth", BOOTH_PROPOSED_ACTION, { business_name: "Bay State Bath" });
    seedRow("snap-card", 1);
    await runCard("snap-card");
    await runCard("snap-card");
    expect(rows(CARD_PAIRED_ACTION)).toHaveLength(1);
  });

  it("an emailed batch: a booth attachment pairs with the card AFTER it in the same email", async () => {
    seedRow("ie1", 0);
    seedBooth(
      "ie1",
      BOOTH_PROPOSED_ACTION,
      {
        business_name: "Fern Hollow",
        photo_key: "inbound-attachments/ie1/0-booth.jpg",
        stage_kind: "booth_new_vendor_uncorroborated",
      },
      "act-ie1-booth"
    );
    const res = await runBoothPipeline(env(cardReply()), asDb(), "ie1", "ev1", [
      { key: "inbound-attachments/ie1/1-card.jpg", name: "1-card.jpg" },
    ]);
    expect(res.cardPairings?.[0]).toMatchObject({
      pairing: "confirmed",
      effect: "booth_written_from_card",
    });
  });
});

describe("booth run looks FORWARD for a card that finished first", () => {
  const unreadableBooth = {
    kind: "booth",
    name: null,
    website: null,
    products: ["pottery"],
    confidence: 0.4,
    rationale: "a booth, sign blurred",
    identifiable_minor: false,
  };

  it("an unreadable booth is named by the card — and approves under that name", async () => {
    seedRow("snap-card", 1);
    seedRow("snap-booth", 0);
    // The card's run finished first: no booth existed yet, so nothing paired.
    expect((await runCard("snap-card")).cardPairings).toBeUndefined();

    const res = await runBoothPipeline(
      env(cardReply(), { main: unreadableBooth }),
      asDb(),
      "snap-booth",
      "ev1",
      shot("snap-booth", "booth.jpg")
    );
    expect(res.cardPairings).toEqual([
      expect.objectContaining({ pairing: "unreadable_booth", effect: "booth_identified" }),
    ]);
    expect(pairedPayloads()[0].resolved_business_name).toBe("Fern Hollow");
    // Still staged for a person — a named booth is not an auto-write.
    expect(db.select().from(vendors).all()).toEqual([]);

    const [booth] = rows(BOOTH_PROPOSED_ACTION);
    const ok = await reviewPhotoProposal({} as never, asDb(), {
      proposalId: booth.id,
      decision: "approve",
      actorUserId: null,
    });
    expect(ok).toMatchObject({ ok: true, resolution: "approved" });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.detail).toMatchObject({
      business_name: "Fern Hollow",
      name_from: "paired_business_card",
    });
  });

  it("a card already paired is not paired again by a nearer booth that finished later", async () => {
    seedRow("snap-b1", 0);
    seedBooth("snap-b1", BOOTH_PROPOSED_ACTION, { business_name: "Bay State Bath" });
    seedRow("snap-card", 3);
    await runCard("snap-card"); // pairs with b1 (order only)
    seedRow("snap-b2", 2); // shot between them, processed last
    const res = await runBoothPipeline(
      env(cardReply(), { main: unreadableBooth }),
      asDb(),
      "snap-b2",
      "ev1",
      shot("snap-b2", "booth.jpg")
    );
    expect(res.cardPairings).toBeUndefined();
    expect(pairedPayloads().map((x) => x.booth_email_id)).toEqual(["snap-b1"]);
  });

  it("a card shot after the window is left alone", async () => {
    seedRow("snap-card", 12);
    seedRow("snap-booth", 0);
    await runCard("snap-card");
    const res = await runBoothPipeline(
      env(cardReply(), { main: unreadableBooth }),
      asDb(),
      "snap-booth",
      "ev1",
      shot("snap-booth", "booth.jpg")
    );
    expect(res.cardPairings).toBeUndefined();
  });

  it("an unreadable booth without a later card still approves only with a name", async () => {
    seedRow("snap-booth", 0);
    await runBoothPipeline(
      env(cardReply(), { main: unreadableBooth }),
      asDb(),
      "snap-booth",
      "ev1",
      shot("snap-booth", "booth.jpg")
    );
    const [booth] = rows(BOOTH_PROPOSED_ACTION);
    const r = await reviewPhotoProposal({} as never, asDb(), {
      proposalId: booth.id,
      decision: "approve",
      actorUserId: null,
    });
    expect(r).toMatchObject({ ok: false, code: "no_name" });
  });
});

describe("card proposals record whether auto-write was open", () => {
  it("auto_write is on the card_proposed payload", async () => {
    seedRow("snap-card", 0);
    await runCard("snap-card", env(cardReply(), { autoWrite: "false" }));
    const [p] = rows(CARD_PROPOSED_ACTION);
    expect(JSON.parse(p.payloadJson!).auto_write).toBe(false);
  });
});
