/**
 * OPE-969 — the photo classifier's four outcomes beyond "booth", and the
 * performer path's roster-check-first rule.
 *
 * Two kinds of evidence:
 *  - REAL model replies (fixtures/ope969-new-gloucester-vision-replies.json):
 *    the 18 photos of the first real batch, run through the shipped prompt +
 *    JSON mode. Parsing and disposition are asserted on what the model
 *    actually said, not on replies written to pass.
 *  - The pipeline end to end on an in-memory D1, for the writes: what is
 *    created, what is not, and that a re-run converges.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import type { Db } from "../src/db.js";
import {
  adminActions,
  eventPerformers,
  eventVendors,
  events,
  inboundEmails,
  performers,
  promoters,
  vendors,
} from "../src/schema.js";
import {
  cleanWebsite,
  disposition,
  parseVisionReply,
  type BoothIdentification,
} from "../src/photo/vision.js";
import {
  BOOTH_PROPOSED_ACTION,
  PERFORMER_CONFIRMED_ACTION,
  PERFORMER_PROPOSED_ACTION,
  SIGNAGE_RECORDED_ACTION,
  runBoothPipeline,
  type BoothPipelineEnv,
} from "../src/photo/booth-pipeline.js";
import { describePhotoStorage } from "../src/email-handlers/photo-intake.js";
import corpus from "./fixtures/ope969-new-gloucester-vision-replies.json";
import waterford from "./fixtures/ope969-waterford-vision-replies.json";
import { matchRosterPerformer } from "../src/photo/performer-photos.js";

const attachGeneralPhotos = vi.fn(async (_env: unknown, _eventId: string, photos: unknown[]) => ({
  attached: photos.length,
  failed: 0,
}));
vi.mock("../src/photo/general-photos.js", () => ({
  attachGeneralPhotos: (env: unknown, eventId: string, photos: unknown[]) =>
    attachGeneralPhotos(env, eventId, photos),
}));

// ── Real replies ──────────────────────────────────────────────────────────

const real = (label: string) => {
  const r = corpus.replies.find((x) => x.label === label);
  if (!r) throw new Error(`fixture has no ${label}`);
  return parseVisionReply({ response: r.response });
};

describe("OPE-969 — on the real New Gloucester replies", () => {
  it("the cheer squad is a PERFORMER, not a nameless booth selling its uniforms", () => {
    const id = real("cheer");
    expect(id.kind).toBe("performer");
    expect(id.businessName).toBeNull();
    expect(id.products).toEqual([]); // products are a booth field
    expect(id.identifiableMinor).toBe(true);
    // "Cheerleading" is a description, not an act — it will not match a
    // performer row, so the pipeline stages it (asserted below).
    expect(disposition(id).action).toBe("performer");
  });

  it("the trail-map board is a BOOTH with its name and site (was: no legible business name)", () => {
    const id = real("trailmap");
    expect(id).toMatchObject({
      kind: "booth",
      businessName: "Casco Bay Trail",
      website: "www.cascobaytrail.org",
    });
  });

  it("the livestock pen is SCENERY → gallery (was: a nameless booth at confidence 1)", () => {
    const id = real("livestock");
    expect(id.kind).toBe("scenery");
    expect(disposition(id).action).toBe("skip");
  });

  it("every real booth that parsed is still a booth — no booth was misrouted", () => {
    const booths = corpus.replies.filter((r) => r.truth === "booth");
    expect(booths.length).toBe(15); // landmark (14 vendors + the trail-map board)
    const parsed = booths.map((r) => parseVisionReply({ response: r.response }));
    const usable = parsed.filter((p) => !p.failureReason);
    expect(usable.length).toBeGreaterThanOrEqual(13); // 2 string replies → the retry's job
    expect(usable.every((p) => p.kind === "booth")).toBe(true);
  });

  it("garbage websites read at confidence 1 are dropped, real ones kept", () => {
    const byB = real("by-b");
    const mcw = real("mainecardworks");
    expect(byB.confidence).toBe(1);
    expect(byB.website).toBeNull(); // model said "noshop/bybinkcrafts"
    expect(mcw.website).toBeNull(); // model said "Watercolors by Carolyn Smith"
    expect(cleanWebsite("www.cascobaytrail.org")).toBe("www.cascobaytrail.org");
    expect(cleanWebsite("https://maplehollow.farm/shop")).toBe("https://maplehollow.farm/shop");
  });
});

describe("OPE-969 — disposition per class", () => {
  const id = (over: Partial<BoothIdentification>): BoothIdentification => ({
    kind: "booth",
    businessName: null,
    performerName: null,
    signText: null,
    website: null,
    products: [],
    confidence: 1,
    rationale: "",
    identifiableMinor: false,
    ...over,
  });

  it("signage is RECORDED — never a proposal, never a write", () => {
    const d = disposition(id({ kind: "signage", signText: "LeafFilter" }));
    expect(d.action).toBe("record");
  });

  it("an unnamed performance stages with its own kind", () => {
    const d = disposition(id({ kind: "performer" }));
    expect(d).toMatchObject({ action: "stage", stageKind: "performer_unnamed" });
  });

  it("stage kinds separate 'booth, name unreadable' from every not-a-booth outcome", () => {
    expect(disposition(id({ kind: "booth" }))).toMatchObject({
      stageKind: "booth_name_unreadable",
    });
    expect(disposition(id({ kind: "unclear" }))).toMatchObject({ stageKind: "unclear" });
    expect(disposition(id({ kind: "scenery" })).action).toBe("skip");
  });

  it("a name the model attached to the wrong kind is dropped", () => {
    const p = parseVisionReply({
      response: { kind: "scenery", name: "Ferris Wheel Co", confidence: 1 },
    });
    expect(p).toMatchObject({ businessName: null, performerName: null, signText: null });
  });
});

// ── The pipeline ──────────────────────────────────────────────────────────

const EVENT = "ev-waterford";
const EMAIL = "ie-969";
let db: TestDb;

const bucket = {
  get: vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
} as unknown as R2Bucket;

function env(...replies: Array<Record<string, unknown>>): BoothPipelineEnv {
  const run = vi.fn();
  for (const r of replies) run.mockResolvedValueOnce({ response: r });
  return { AI: { run }, VENDOR_ASSETS: bucket, PHOTO_VISION_ENABLED: "true" };
}
const photo = (n: number) => ({ key: `inbound-attachments/m/${n}-p.jpg`, name: `${n}-p.jpg` });
const reply = (over: Record<string, unknown>) => ({
  kind: "booth",
  name: null,
  website: null,
  products: [],
  confidence: 1,
  rationale: "",
  identifiable_minor: false,
  ...over,
});

const actions = async (action: string) =>
  (await db.select().from(adminActions).where(eq(adminActions.action, action))).map((r) =>
    JSON.parse(r.payloadJson as string)
  );
const appearances = async () => db.select().from(eventPerformers);
const flagged = async () =>
  (await db.select().from(inboundEmails).where(eq(inboundEmails.id, EMAIL)))[0].flaggedForReview;

beforeEach(async () => {
  attachGeneralPhotos.mockClear();
  ({ db } = createTestDb());
  db.insert(promoters)
    .values({ id: "p1", companyName: "P", slug: "p" } as never)
    .run();
  db.insert(events)
    .values({
      id: EVENT,
      name: "Waterford World's Fair",
      slug: "waterford",
      promoterId: "p1",
      status: "APPROVED",
    } as never)
    .run();
  db.insert(inboundEmails)
    .values({
      id: EMAIL,
      receivedAt: new Date(),
      fromAddress: "john@pimboat.com",
      toAddress: "photos@meetmeatthefair.com",
      intent: "photo_intake",
      status: "received",
      attachmentCount: 1,
      flaggedForReview: 0,
      createdAt: new Date(),
    } as never)
    .run();
  const perf = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    db
      .insert(performers)
      .values({ id, name, slug: id, ...extra } as never)
      .run();
  perf("axe", "Axe Women Loggers of Maine");
  perf("axe-alias", "Axe Women", {
    aliasOfPerformerId: "axe",
    redirectToPerformerId: "axe",
    deletedAt: new Date(),
  });
  perf("fiddler", "Downeast Fiddlers");
  // Axe Women are ALREADY HEADLINER ×3 on this event — the Waterford specimen.
  for (let i = 0; i < 3; i++) {
    db.insert(eventPerformers)
      .values({
        id: `ap-${i}`,
        eventId: EVENT,
        performerId: "axe",
        status: "CONFIRMED",
        billing: "HEADLINER",
      } as never)
      .run();
  }
});

const run = (e: BoothPipelineEnv, photos = [photo(1)], dryRun = false) =>
  runBoothPipeline(e, db as unknown as Db, EMAIL, EVENT, photos, { dryRun });

describe("OPE-969 — performer photos, roster first", () => {
  it("ACCEPTANCE: on the roster → photo attached, NO new appearance, nothing staged", async () => {
    const res = await run(env(reply({ kind: "performer", name: "Axe Women Loggers of Maine" })));
    expect(await appearances()).toHaveLength(3); // unchanged
    expect(res.performersConfirmed).toEqual([
      { performerId: "axe", performerName: "Axe Women Loggers of Maine", photoName: "1-p.jpg" },
    ]);
    expect(attachGeneralPhotos).toHaveBeenCalledWith(expect.anything(), EVENT, [photo(1)]);
    expect(await actions(PERFORMER_CONFIRMED_ACTION)).toMatchObject([
      { performer_id: "axe", appearances_on_event: 3 },
    ]);
    expect(await actions(PERFORMER_PROPOSED_ACTION)).toHaveLength(0);
    expect(await flagged()).toBe(0);
  });

  it("a performance with NO printed name → a performer proposal, never a booth proposal", async () => {
    await run(env(reply({ kind: "performer", name: null })));
    expect(await actions(PERFORMER_PROPOSED_ACTION)).toMatchObject([
      { stage_kind: "performer_unnamed", photo_class: "performer" },
    ]);
    expect(await actions(BOOTH_PROPOSED_ACTION)).toHaveLength(0);
  });

  it("an ALIAS name resolves to the canonical performer on the roster", async () => {
    const res = await run(env(reply({ kind: "performer", name: "axe women" })));
    expect(res.performersConfirmed[0]?.performerId).toBe("axe");
    expect(await appearances()).toHaveLength(3);
  });

  it("ACCEPTANCE: a known performer NOT on the roster → held proposal, no write", async () => {
    const res = await run(env(reply({ kind: "performer", name: "Downeast Fiddlers" })));
    expect(await appearances()).toHaveLength(3);
    expect(res.performerStaged).toBe(1);
    expect(await actions(PERFORMER_PROPOSED_ACTION)).toMatchObject([
      { stage_kind: "performer_not_on_roster", performer_id: "fiddler", photo_class: "performer" },
    ]);
    expect(attachGeneralPhotos).not.toHaveBeenCalled();
    expect(await flagged()).toBe(1);
  });

  it("an unknown act (the real 'Cheerleading' reply) → held as unmatched", async () => {
    const cheer = corpus.replies.find((r) => r.label === "cheer")!.response as Record<
      string,
      unknown
    >;
    await run(env(cheer));
    expect(await actions(PERFORMER_PROPOSED_ACTION)).toMatchObject([
      { stage_kind: "performer_unmatched" },
    ]);
    expect(await actions(BOOTH_PROPOSED_ACTION)).toHaveLength(0); // not a booth any more
    expect(await appearances()).toHaveLength(3);
  });

  it("FACES: on the roster but a child may be identifiable → staged, NOT attached", async () => {
    for (const minor of [true, undefined]) {
      attachGeneralPhotos.mockClear();
      const r = reply({ kind: "performer", name: "Axe Women Loggers of Maine" });
      if (minor === undefined) delete (r as Record<string, unknown>).identifiable_minor;
      else r.identifiable_minor = minor;
      const res = await run(env(r), [photo(minor ? 2 : 3)]);
      expect(res.performersConfirmed).toEqual([]);
      expect(attachGeneralPhotos).not.toHaveBeenCalled();
    }
    expect((await actions(PERFORMER_PROPOSED_ACTION)).map((a) => a.stage_kind)).toEqual([
      "performer_identifiable_minor",
      "performer_identifiable_minor",
    ]);
  });
});

describe("OPE-969 — the other classes", () => {
  it("ACCEPTANCE: scenery → gallery; booth → booth path; neither misrouted", async () => {
    await run(
      env(
        reply({ kind: "scenery" }),
        reply({ kind: "booth", name: "Maple Hollow Farm", confidence: 0.9 })
      ),
      [photo(1), photo(2)]
    );
    expect(attachGeneralPhotos).toHaveBeenCalledWith(expect.anything(), EVENT, [photo(1)]);
    const booths = await actions(BOOTH_PROPOSED_ACTION);
    expect(booths).toHaveLength(1);
    expect(booths[0]).toMatchObject({
      photo_key: photo(2).key,
      photo_class: "booth",
      business_name: "Maple Hollow Farm",
    });
  });

  it("ACCEPTANCE: a banner behind another booth → recorded signage, NO vendor proposal, nothing else", async () => {
    const res = await run(env(reply({ kind: "signage", name: "LeafFilter Gutter Protection" })));
    expect(res.signageRecorded).toBe(1);
    expect(await actions(SIGNAGE_RECORDED_ACTION)).toMatchObject([
      { sign_text: "LeafFilter Gutter Protection", photo_class: "signage" },
    ]);
    expect(await actions(BOOTH_PROPOSED_ACTION)).toHaveLength(0);
    expect(attachGeneralPhotos).not.toHaveBeenCalled();
    expect(await flagged()).toBe(0);
    // A deliberate record is not a photo that "landed nowhere".
    expect(describePhotoStorage(1, res).blockedReason).toBeNull();
  });

  it("ACCEPTANCE: stage_kind tells 'booth, name unreadable' apart from 'not a booth'", async () => {
    await run(env(reply({ kind: "booth" }), reply({ kind: "unclear" })), [photo(1), photo(2)]);
    expect((await actions(BOOTH_PROPOSED_ACTION)).map((a) => a.stage_kind).sort()).toEqual([
      "booth_name_unreadable",
      "unclear",
    ]);
  });
});

describe("OPE-969 — re-running an email converges", () => {
  it("ACCEPTANCE: a second run adds no appearance, no audit row, no proposal", async () => {
    const batch = () =>
      env(
        reply({ kind: "performer", name: "Axe Women Loggers of Maine" }),
        reply({ kind: "performer", name: "Downeast Fiddlers" }),
        reply({ kind: "signage", name: "LeafFilter" }),
        reply({ kind: "booth", name: "Maple Hollow Farm", confidence: 0.5 })
      );
    const photos = [photo(1), photo(2), photo(3), photo(4)];
    await run(batch(), photos);
    const first = (await db.select().from(adminActions)).length;
    expect(first).toBe(4); // landmark: the first run DID write
    await run(batch(), photos);
    expect((await db.select().from(adminActions)).length).toBe(first);
    expect(await appearances()).toHaveLength(3);
  });

  it("a dry run reports the performer outcome and writes nothing", async () => {
    const res = await run(
      env(reply({ kind: "performer", name: "Axe Women Loggers of Maine" })),
      [photo(1)],
      true
    );
    expect(res.dryRun).toBe(true);
    expect(res.performersConfirmed).toHaveLength(1);
    expect(res.galleryAttached).toBe(1);
    expect(await db.select().from(adminActions)).toHaveLength(0);
    expect(attachGeneralPhotos).not.toHaveBeenCalled();
  });
});

describe("OPE-969 — the decision-stage heartbeat probe sees the new actions", () => {
  it("every decision action the pipeline writes is in the booth-autowrite probe's evidence", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../../src/lib/heartbeat.ts"), "utf8");
    const probe = src.slice(
      src.indexOf('name: "booth-autowrite"'),
      src.indexOf("OPE-309 (assurance audit")
    );
    expect(probe).toContain("vendor.photo_proposed"); // landmark
    for (const a of [
      PERFORMER_PROPOSED_ACTION,
      PERFORMER_CONFIRMED_ACTION,
      SIGNAGE_RECORDED_ACTION,
    ]) {
      expect(probe).toContain(`"${a}"`);
    }
  });
});

// ── The Waterford specimen, on its own photos ─────────────────────────────

describe("OPE-969 — the Axe Women truck, as the model actually read it", () => {
  const truck = waterford.replies.find(
    (r) => r.label === "wf-1411" && typeof r.response === "object"
  )!.response as Record<string, unknown>;

  it("LANDMARK: the model called the act's truck a BOOTH named 'AxeWomen' at confidence 1", () => {
    expect(truck).toMatchObject({ kind: "booth", name: "AxeWomen", confidence: 1 });
    expect(disposition(parseVisionReply({ response: truck })).action).toBe("write");
  });

  it("ACCEPTANCE: the roster wins — confirmed, NO vendor, NO booth proposal, NO new appearance, even with auto-write ON", async () => {
    // As prod is (measured 2026-09-13): no "Axe Women" alias row exists, so the
    // real specimen resolves through the prefix rule alone.
    db.delete(performers).where(eq(performers.id, "axe-alias")).run();
    const e = env(truck);
    e.PHOTO_AUTOWRITE_ENABLED = "true";
    const res = await run(e);
    expect(res.performersConfirmed).toMatchObject([{ performerId: "axe" }]);
    expect(res.autoWritten).toEqual([]);
    expect(await db.select().from(vendors)).toHaveLength(0);
    expect(await db.select().from(eventVendors)).toHaveLength(0);
    expect(await actions(BOOTH_PROPOSED_ACTION)).toHaveLength(0);
    expect(await appearances()).toHaveLength(3);
    expect(await actions(PERFORMER_CONFIRMED_ACTION)).toMatchObject([
      { performer_id: "axe", reclassified_from: "booth" },
    ]);
  });

  it("a real booth on the same event (Central Maine Power) still takes the booth path", async () => {
    const cmp = waterford.replies.find((r) => r.label === "wf-1121")!.response as Record<
      string,
      unknown
    >;
    const res = await run(env({ ...cmp, confidence: 0.9 }));
    expect(res.performersConfirmed).toEqual([]);
    expect(await actions(BOOTH_PROPOSED_ACTION)).toMatchObject([
      { business_name: "Central Maine Power" },
    ]);
  });

  it("roster matching: compact equality or a ≥6-char prefix, and nothing shorter", async () => {
    const m = (name: string) => matchRosterPerformer(db as unknown as Db, EVENT, name);
    expect((await m("AxeWomen"))?.id).toBe("axe");
    expect((await m("AXE WOMEN LOGGERS OF MAINE"))?.id).toBe("axe");
    // Equal to neither the canonical name nor the "Axe Women" alias — only the
    // prefix rule can match it.
    expect((await m("Axe Women Loggers"))?.id).toBe("axe");
    expect(await m("Axe")).toBeNull(); // too short to prefix-match
    expect(await m("Downeast Fiddlers")).toBeNull(); // a performer, but not on THIS lineup
    expect(await m("Central Maine Power")).toBeNull();
  });

  it("a roster-check FAULT never lets a booth auto-write on the strength of not being checked", async () => {
    const e = env(reply({ kind: "booth", name: "Maple Hollow Farm", confidence: 1 }));
    e.PHOTO_AUTOWRITE_ENABLED = "true";
    const spy = vi
      .spyOn(await import("../src/photo/performer-photos.js"), "matchRosterPerformer")
      .mockRejectedValueOnce(new Error("D1 unavailable"));
    const res = await run(e);
    spy.mockRestore();
    expect(res.autoWritten).toEqual([]);
    expect(await actions(BOOTH_PROPOSED_ACTION)).toMatchObject([
      { stage_kind: "booth_roster_check_failed" },
    ]);
  });
});
