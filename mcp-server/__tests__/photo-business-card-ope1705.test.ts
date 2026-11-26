/**
 * OPE-1705 — business cards in the photo lane (slice 1: class, read, match, write).
 *
 * John's ruling (a), 2026-11-22: identity fields (website, social, address) fill a
 * matched vendor's BLANK columns; contact email / phone / name are ALWAYS staged
 * as private enrichment candidates; a disagreement is a conflict, never an
 * overwrite; the card image is never published.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  adminActions,
  events,
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
import {
  applyCardPlan,
  cardFromPayload,
  cardNameProblem,
  normalizePhone,
  parseCardReply,
  parseSocialEntry,
  planCardFields,
  type CardReading,
  type VendorCardSnapshot,
} from "../src/photo/business-card.js";
import { disposition, parseVisionReply } from "../src/photo/vision.js";
import { reviewPhotoProposal } from "../src/photo/review-proposal.js";
import type { Db } from "../src/db.js";

const f = (value: unknown, confidence = 1) => ({ value, confidence });

describe("parseCardReply — every field passes a shape check, or is absent", () => {
  it("normalises what it can and drops what is not the field's shape", () => {
    const r = parseCardReply({
      response: {
        business_name: f("Bay State Bath Co."),
        contact_name: f("Jane Doe"),
        phone: f("207.555.0123"),
        email: f("Jane@BayStateBath.com"),
        website: f("www.baystatebath.com"),
        social: f(["instagram.com/baystatebath", "@justahandle", "FB: baystatebathco"]),
        street: f("12 Main St"),
        city: f("Portland"),
        state: f("me"),
        zip: f("04101"),
      },
    });
    expect(r.businessName?.value).toBe("Bay State Bath Co.");
    expect(r.phone?.value).toBe("(207) 555-0123");
    expect(r.email?.value).toBe("jane@baystatebath.com");
    expect(r.website?.value).toBe("www.baystatebath.com");
    expect(r.state?.value).toBe("ME");
    expect(r.zip?.value).toBe("04101");
    // A bare @handle names no platform: dropped, never guessed.
    expect(r.social?.value).toEqual({
      instagram: "https://instagram.com/baystatebath",
      facebook: "https://facebook.com/baystatebathco",
    });
    expect(r.failureReason).toBeUndefined();
  });

  it("a half-read value is missing, not invented", () => {
    const r = parseCardReply({
      response: {
        business_name: f(null),
        contact_name: f("J4ne"),
        phone: f("207-555-012"), // 9 digits
        email: f("jane@baystatebath"), // no TLD
        website: f("Bay State Bath"), // a tagline in the website field
        social: f([]),
        street: f("Main St"), // no number
        city: f("04101"),
        state: f("Maine"),
        zip: f("0410"),
      },
    });
    expect(r).toEqual({});
  });

  it("reads a string reply, and marks an unreadable one", () => {
    const ok = parseCardReply({
      response: 'Sure: {"business_name":{"value":"Fern Hollow","confidence":1}}',
    });
    expect(ok.businessName?.value).toBe("Fern Hollow");
    expect(parseCardReply({ response: "I can't read this card." }).failureReason).toMatch(
      /unreadable/
    );
  });

  it("phones: 10 NANP digits, a leading 1 stripped, an impossible area code refused", () => {
    expect(normalizePhone("1 (603) 555-0199")).toBe("(603) 555-0199");
    expect(normalizePhone("603-555-0199 ext 12")).toBe("(603) 555-0199");
    expect(normalizePhone("055-555-0199")).toBeNull();
    expect(normalizePhone("555-0199")).toBeNull();
  });

  it("social: platform from the host or a 'platform: handle' pair only", () => {
    expect(parseSocialEntry("https://www.etsy.com/shop/fernhollow")).toEqual([
      "etsy",
      "https://etsy.com/shop/fernhollow",
    ]);
    expect(parseSocialEntry("IG: @fernhollow")).toEqual([
      "instagram",
      "https://instagram.com/fernhollow",
    ]);
    expect(parseSocialEntry("instagram.com")).toBeNull(); // no handle
    expect(parseSocialEntry("fernhollow.com")).toBeNull(); // not a social host
  });
});

// OPE-1709 rework — the `social` arrays below are the SHAPES (values anonymised) of 2026-11-26
// replays of the prod CARD_PROMPT on the stored Maple Grain Co card
// (snap-dc426dc2) — the 20/2o misread is kept. The model read the email and website correctly but filed them
// under `social`, leaving `email` / `website` absent — 5 of 6 runs.
describe("parseCardReply — a misfiled email / website is salvaged from social (OPE-1709)", () => {
  const reply = (social: string[], extra: Record<string, unknown> = {}) => ({
    business_name: f("Maple Grain Co"),
    contact_name: f("Pat Example"),
    social: { value: social, confidence: 1 },
    ...extra,
  });

  it("salvages the one email and the one plain domain (prod run 0)", () => {
    const r = parseCardReply(
      reply([
        "maplegrain20@example.com",
        "maplegrain.example",
        "maplegrain20@",
        "maplegrain.example",
        "@MapleGrainCo",
      ])
    );
    expect(r.email).toEqual({ value: "maplegrain20@example.com", confidence: 1, salvaged: true });
    expect(r.website).toEqual({ value: "maplegrain.example", confidence: 1, salvaged: true });
    expect(r.social).toBeUndefined(); // the bare @handle is still dropped
  });

  it("salvages nothing when two DIFFERENT emails were read (prod run 3: 20 vs 2o)", () => {
    const r = parseCardReply(
      reply(["maplegrain2o@example.com", "maplegrain.example", "maplegrain20@example.com"])
    );
    expect(r.email).toBeUndefined();
    expect(r.website?.value).toBe("maplegrain.example");
  });

  it("never overrides a value the model put in its own field", () => {
    const r = parseCardReply(
      reply(["other@elsewhere.com", "elsewhere.com"], {
        email: f("maplegrain20@example.com"),
        website: f("maplegrain.example"),
      })
    );
    expect(r.email).toEqual({ value: "maplegrain20@example.com", confidence: 1 });
    expect(r.website).toEqual({ value: "maplegrain.example", confidence: 1 });
  });

  it("does not salvage a social-host URL as the website", () => {
    const r = parseCardReply(reply(["instagram.com/maplegrain"]));
    expect(r.website).toBeUndefined();
    expect(r.social?.value).toEqual({ instagram: "https://instagram.com/maplegrain" });
  });

  it("a salvaged website STAGES even at 1.0 with auto-write on; a read one writes", () => {
    const salvaged = parseCardReply(reply(["maplegrain.example"]));
    const plans = planCardFields(salvaged, EMPTY, { autoWrite: true });
    const site = plans.find((p) => p.column === "website");
    expect(site?.action).toBe("stage");
    expect(site?.salvaged).toBe(true);
    const read = parseCardReply(reply([], { website: f("maplegrain.example") }));
    const readSite = planCardFields(read, EMPTY, { autoWrite: true }).find(
      (p) => p.column === "website"
    );
    expect(readSite?.action).toBe("write");
    expect(readSite?.salvaged).toBeUndefined();
  });

  it("`salvaged` survives the stored-proposal round trip (cardFromPayload)", () => {
    const stored = JSON.parse(JSON.stringify(parseCardReply(reply(["maplegrain.example"]))));
    const back = cardFromPayload(stored);
    expect(back.website).toEqual({ value: "maplegrain.example", confidence: 1, salvaged: true });
    const site = planCardFields(back, EMPTY, { autoWrite: true }).find(
      (p) => p.column === "website"
    );
    expect(site?.action).toBe("stage");
  });

  it("a staged salvaged field carries the card_field_salvaged flag", async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: "u-mg", email: "mg@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({
        id: "v-mg",
        userId: "u-mg",
        businessName: "Maple Grain Co",
        slug: "maple-grain-co",
      })
      .run();
    const card = parseCardReply(reply(["maplegrain20@example.com"]));
    const res = await applyCardPlan(
      db as unknown as Db,
      "v-mg",
      planCardFields(card, EMPTY, { autoWrite: true }),
      { sourceRef: "test", jobRunId: "test" }
    );
    expect(res.staged).toContain("contact_email");
    const rows = db
      .select()
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.proposedField, "contact_email"))
      .all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].flags)).toEqual(["business_card", "card_field_salvaged"]);
  });
});

describe("the classifier knows a business card", () => {
  it("kind business_card keeps the printed name and routes to the card path", () => {
    const id = parseVisionReply({
      response: { kind: "business_card", name: "Fern Hollow", confidence: 1, rationale: "card" },
    });
    expect(id.kind).toBe("business_card");
    expect(id.businessName).toBe("Fern Hollow");
    expect(disposition(id).action).toBe("card");
  });

  it("a salvaged card reply still stages — never the card path", () => {
    const id = parseVisionReply({
      response: "* **kind**: business_card\n* **name**: Fern Hollow\n* confidence: 1",
    });
    expect(id.salvaged).toBe("markdown");
    expect(disposition(id).action).toBe("stage");
  });
});

const EMPTY: VendorCardSnapshot = {
  website: null,
  socialLinks: null,
  address: null,
  city: null,
  state: null,
  zip: null,
  contactEmail: null,
  contactPhone: null,
  contactName: null,
};
const CARD: CardReading = {
  businessName: f("Fern Hollow") as never,
  website: f("fernhollow.com") as never,
  email: f("jane@fernhollow.com") as never,
  phone: f("(207) 555-0123") as never,
  contactName: f("Jane Doe") as never,
  city: f("Gray") as never,
  social: { value: { instagram: "https://instagram.com/fernhollow" }, confidence: 1 },
};
const byCol = (plans: ReturnType<typeof planCardFields>) =>
  Object.fromEntries(plans.map((p) => [p.column, p.action]));

describe("planCardFields — ruling (a)", () => {
  it("identity blanks write; contact fields ALWAYS stage, even with auto-write on", () => {
    expect(byCol(planCardFields(CARD, EMPTY, { autoWrite: true }))).toEqual({
      website: "write",
      city: "write",
      social_links: "write",
      contact_email: "stage",
      contact_phone: "stage",
      contact_name: "stage",
    });
  });

  it("auto-write off: every field stages, nothing writes", () => {
    const plans = planCardFields(CARD, EMPTY, { autoWrite: false });
    expect(plans.every((p) => p.action === "stage")).toBe(true);
  });

  it("below the 1.0 bar: an identity field stages instead of writing", () => {
    const c = { ...CARD, website: f("fernhollow.com", 0.9) as never };
    expect(byCol(planCardFields(c, EMPTY, { autoWrite: true })).website).toBe("stage");
  });

  it("a different existing value is a conflict; the same value (any spelling) is nothing", () => {
    const v = {
      ...EMPTY,
      website: "https://www.FernHollow.com/",
      contactPhone: "207-555-9999",
      city: "Gray",
    };
    const plans = byCol(planCardFields(CARD, v, { autoWrite: true }));
    expect(plans.website).toBe("same");
    expect(plans.city).toBe("same");
    expect(plans.contact_phone).toBe("conflict");
  });

  it("social merges per network and conflicts only on the same network", () => {
    const merged = planCardFields(
      CARD,
      { ...EMPTY, socialLinks: JSON.stringify({ facebook: "https://facebook.com/fh" }) },
      { autoWrite: true }
    ).find((p) => p.column === "social_links");
    expect(merged?.action).toBe("write");
    expect(JSON.parse(merged!.value)).toEqual({
      facebook: "https://facebook.com/fh",
      instagram: "https://instagram.com/fernhollow",
    });
    const clash = planCardFields(
      CARD,
      { ...EMPTY, socialLinks: JSON.stringify({ instagram: "https://instagram.com/other" }) },
      { autoWrite: true }
    ).find((p) => p.column === "social_links");
    expect(clash?.action).toBe("conflict");
  });

  it("name problems", () => {
    expect(cardNameProblem({})).toBe("card_name_unreadable");
    expect(cardNameProblem({ failureReason: "x" })).toBe("card_unreadable");
    expect(cardNameProblem({ businessName: f("Fern Hollow", 0.8) as never })).toBe(
      "card_name_unreadable"
    );
    expect(cardNameProblem({ businessName: f("Welcome") as never })).toBe("card_name_generic");
    expect(cardNameProblem(CARD)).toBeNull();
  });
});

// ─── The pipeline, on a real (sqlite) schema ────────────────────────────────

let db: TestDb;
function seedVendor(id: string, businessName: string, extra: Record<string, unknown> = {}) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id, ...extra } as never)
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
const env = (card: unknown, autoWrite = "true"): BoothPipelineEnv => ({
  AI: {
    run: async (_m: string, input: { prompt: string }) =>
      input.prompt.includes("BUSINESS CARD")
        ? card
        : {
            response: {
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
  PHOTO_AUTOWRITE_ENABLED: autoWrite,
});
const photos = [{ key: "inbound-attachments/snap-x/0-card.jpg", name: "0-card.jpg" }];
const actions = () => db.select().from(adminActions).all();
const candidates = () => db.select().from(vendorEnrichmentCandidates).all();
const vendorRow = (id: string) => db.select().from(vendors).where(eq(vendors.id, id)).get()!;

describe("runBoothPipeline — a business card", () => {
  it("matched by its website's domain: identity blanks written, contacts staged, no image anywhere", async () => {
    seedVendor("v1", "Fern Hollow Farm", { website: "https://fernhollow.com", logoUrl: null });
    const res = await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);

    expect(res.cards?.applied).toEqual([
      expect.objectContaining({
        vendorId: "v1",
        matchBasis: "domain",
        written: ["city", "state"],
        staged: ["contact_email", "contact_phone", "contact_name"],
        conflicts: [],
      }),
    ]);
    const v = vendorRow("v1");
    expect([v.city, v.state]).toEqual(["Gray", "ME"]);
    // Ruling (a): the contact fields are NOT on the public row.
    expect([v.contactEmail, v.contactPhone, v.contactName]).toEqual([null, null, null]);
    expect(v.logoUrl).toBeNull(); // the card never becomes a logo/hero
    expect(
      candidates().map((c) => [c.proposedField, c.proposedValue, c.decision, c.extractionMethod])
    ).toEqual([
      ["contact_email", "jane@fernhollow.com", "pending", "business_card"],
      ["contact_phone", "(207) 555-0123", "pending", "business_card"],
      ["contact_name", "Jane Doe", "pending", "business_card"],
    ]);
    const acts = actions().map((a) => a.action);
    expect(acts).toEqual([CARD_APPLIED_ACTION]);
    expect(acts).not.toContain(BOOTH_PROPOSED_ACTION); // never selectable by a booth tail
    expect(res.galleryAttached).toBe(0);
  });

  it("a conflicting phone is staged and flagged, never written", async () => {
    seedVendor("v1", "Fern Hollow", { contactPhone: "(207) 555-9999" });
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    expect(vendorRow("v1").contactPhone).toBe("(207) 555-9999");
    const phone = candidates().find((c) => c.proposedField === "contact_phone")!;
    expect(JSON.parse(phone.flags)).toEqual(["business_card", "card_conflict"]);
    expect(phone.currentValue).toBe("(207) 555-9999");
  });

  it("matched by strict name when the card carries no owned domain", async () => {
    seedVendor("v2", "Fern Hollow");
    const res = await runBoothPipeline(
      env(cardReply({ website: f(null), email: f("user.alder@gmail.com") })),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos
    );
    expect(res.cards?.applied[0]).toMatchObject({ vendorId: "v2", matchBasis: "name" });
  });

  it("auto-write OFF: nothing is written to the vendor, every field staged", async () => {
    seedVendor("v1", "Fern Hollow", { website: "https://fernhollow.com" });
    await runBoothPipeline(env(cardReply(), "false"), db as unknown as Db, "ie1", "ev1", photos);
    const v = vendorRow("v1");
    expect([v.city, v.state]).toEqual([null, null]);
    expect(
      candidates()
        .map((c) => c.proposedField)
        .sort()
    ).toEqual(["city", "contact_email", "contact_name", "contact_phone", "state"].sort());
  });

  it("no vendor matches: a card-only proposal under its OWN action, nothing created", async () => {
    const before = db.select().from(vendors).all().length;
    const res = await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    expect(res.cards?.proposed).toEqual([
      { businessName: "Fern Hollow", stageKind: "card_unmatched" },
    ]);
    expect(db.select().from(vendors).all().length).toBe(before);
    const [a] = actions();
    // The LITERAL, not the constant: a constant compared with itself cannot
    // catch the constant being changed to the booth action (driven: it didn't).
    expect(a.action).toBe("vendor.card_proposed");
    expect(CARD_PROPOSED_ACTION).not.toBe(BOOTH_PROPOSED_ACTION);
    expect(JSON.parse(a.payloadJson!).card.email).toEqual({
      value: "jane@fernhollow.com",
      confidence: 1,
    });
  });

  it("an unreadable name with no domain stages as unreadable", async () => {
    seedVendor("v2", "Fern Hollow");
    const res = await runBoothPipeline(
      env(cardReply({ business_name: f("Fern Hollow", 0.6), website: f(null), email: f(null) })),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos
    );
    expect(res.cards?.proposed[0].stageKind).toBe("card_name_unreadable");
    expect(res.cards?.applied).toEqual([]);
  });

  it("dry run reports the plan and writes nothing", async () => {
    seedVendor("v1", "Fern Hollow", { website: "https://fernhollow.com" });
    const res = await runBoothPipeline(
      env(cardReply()),
      db as unknown as Db,
      "ie1",
      "ev1",
      photos,
      {
        dryRun: true,
      }
    );
    expect(res.cards?.applied[0].written).toEqual(["city", "state"]);
    expect(vendorRow("v1").city).toBeNull();
    expect(candidates()).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it("a replay of the same email does not apply the card twice", async () => {
    seedVendor("v1", "Fern Hollow", { website: "https://fernhollow.com" });
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    expect(actions().filter((a) => a.action === CARD_APPLIED_ACTION)).toHaveLength(1);
    expect(candidates()).toHaveLength(3);
  });
});

describe("review_photo_proposal — a card proposal", () => {
  it("approve needs a vendor_id, applies the card, and writes no image", async () => {
    await runBoothPipeline(env(cardReply()), db as unknown as Db, "ie1", "ev1", photos);
    const [p] = actions();
    seedVendor("v9", "Fern Hollow Gardens");

    const noVendor = await reviewPhotoProposal({} as never, db as unknown as Db, {
      proposalId: p.id,
      decision: "approve",
      actorUserId: null,
    });
    expect(noVendor).toMatchObject({ ok: false, code: "card_needs_vendor" });

    const ok = await reviewPhotoProposal({} as never, db as unknown as Db, {
      proposalId: p.id,
      decision: "approve",
      vendorId: "v9",
      actorUserId: null,
    });
    expect(ok).toMatchObject({ ok: true, resolution: "approved" });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.detail).toMatchObject({
      card_written: ["website", "city", "state"],
      card_staged: ["contact_email", "contact_phone", "contact_name"],
      photo_written_as: "none",
    });
    const v = vendorRow("v9");
    expect([v.website, v.contactEmail, v.logoUrl]).toEqual(["fernhollow.com", null, null]);
  });
});
