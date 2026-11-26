/**
 * OPE-1695 — a "Welcome" sign became a published vendor named "Welcome" at
 * confidence 1.0. Pinned: the generic-word guard, the echo check, and the
 * corroboration rule for brand-new vendors (linking an existing one is
 * unaffected), plus the 11-20 batch's legitimate writes still writing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { adminActions, events, promoters, users, vendors } from "../src/schema.js";
import {
  GENERIC_SIGN_PHRASES,
  GENERIC_SIGN_WORDS,
  hasIndependentProducts,
  isGenericSignName,
  isProductEcho,
} from "../src/photo/sign-words.js";
import { disposition, type BoothIdentification } from "../src/photo/vision.js";
import { runBoothPipeline, type BoothPipelineEnv } from "../src/photo/booth-pipeline.js";
import type { Db } from "../src/db.js";

const TICKET_WORDS = [
  "Welcome",
  "Sale",
  "Open",
  "Closed",
  "Handmade",
  "Homemade",
  "Local",
  "Crafts",
  "Gifts",
  "Thank You",
  "Cash Only",
  "Card Accepted",
  "Venmo",
  "Prices",
  "Each",
  "Free",
  "New",
  "Hello",
  "Booth",
  "Vendor",
  "Raffle",
  "Shop Small",
  "December",
  "Merry Christmas",
];

describe("isGenericSignName", () => {
  it.each(TICKET_WORDS)("rejects %s alone", (w) => {
    expect(isGenericSignName(w)).toBe(true);
  });

  it.each([
    "WELCOME!",
    "Welcome to our booth",
    "Handmade Gifts",
    "Cash or Venmo only",
    "$5 Each",
    "Happy Holidays!",
  ])("rejects composites of sign text: %s", (w) => {
    expect(isGenericSignName(w)).toBe(true);
  });

  it.each([
    "Welcome Home Candles",
    "Open Hearth Pottery",
    "Central Maine Power",
    "Colley Hill Soy Candles",
    "Momma Bear's Wild Things",
    "Maine CardWorks",
    "Fall River Farm",
    "May's Bakery",
    "New Gloucester Historical Society",
  ])("keeps a real name containing a generic word: %s", (n) => {
    expect(isGenericSignName(n)).toBe(false);
  });

  it("every list entry is lowercase and trimmed (the list stays easy to extend)", () => {
    for (const w of [...GENERIC_SIGN_WORDS, ...GENERIC_SIGN_PHRASES]) {
      expect(w).toBe(w.toLowerCase().trim());
    }
  });
});

describe("product echo", () => {
  it("flags products that only repeat the name", () => {
    expect(isProductEcho("Welcome", ["Welcome", "Welcome"])).toBe(true);
    expect(isProductEcho("Welcome", ["welcome"])).toBe(true);
    expect(isProductEcho("Welcome", [])).toBe(false);
    expect(isProductEcho("Colley Hill Soy Candles", ["candles"])).toBe(false);
    expect(hasIndependentProducts("Welcome", ["Welcome"])).toBe(false);
    expect(hasIndependentProducts("Momma Bear's Wild Things", ["spices"])).toBe(true);
  });
});

const booth = (over: Partial<BoothIdentification> = {}): BoothIdentification => ({
  kind: "booth",
  businessName: "Welcome",
  performerName: null,
  signText: null,
  website: null,
  products: ["Welcome", "Welcome"],
  confidence: 1,
  rationale: "sign",
  identifiableMinor: false,
  ...over,
});

describe("disposition — generic and echo stage before anything writes", () => {
  it("the specimen stages as booth_name_generic", () => {
    const d = disposition(booth());
    expect(d.action).toBe("stage");
    expect(d.action === "stage" && d.stageKind).toBe("booth_name_generic");
    expect(d.action === "stage" && d.reason).toMatch(/generic sign text/);
  });

  it("a non-generic name with echoed products stages as booth_name_echo", () => {
    const d = disposition(booth({ businessName: "Bluebird", products: ["Bluebird", "bluebird"] }));
    expect(d.action === "stage" && d.stageKind).toBe("booth_name_echo");
  });

  it("a real name still writes", () => {
    expect(disposition(booth({ businessName: "Welcome Home Candles", products: [] })).action).toBe(
      "write"
    );
  });
});

let db: TestDb;
function seedVendor(id: string, businessName: string) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "ev1", name: "CMP Fair", slug: "cmp-fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

describe("runBoothPipeline — a NEW vendor needs corroboration to auto-write", () => {
  const env = (over: Record<string, unknown>): BoothPipelineEnv => ({
    AI: {
      run: async () => ({
        response: JSON.stringify({
          kind: "booth",
          name: "Bluebird Studio",
          website: null,
          products: [],
          confidence: 1,
          rationale: "sign",
          identifiable_minor: false,
          mounted_on: "vendor_table_or_tent",
          ...over,
        }),
      }),
    },
    VENDOR_ASSETS: {
      get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
    } as unknown as R2Bucket,
    PHOTO_VISION_ENABLED: "true",
    PHOTO_AUTOWRITE_ENABLED: "true",
  });
  const photos = [{ key: "inbound-attachments/s/0.jpg", name: "0.jpg" }];
  const run = (over: Record<string, unknown>, dryRun = true) =>
    runBoothPipeline(env(over), db as unknown as Db, "ie1", "ev1", photos, { dryRun });
  const vendorCount = () => db.select().from(vendors).all().length;

  it("brand-new, name only → staged booth_new_vendor_uncorroborated, nothing created", async () => {
    const before = vendorCount();
    const res = await run({}, false);
    expect(res.autoWritten).toEqual([]);
    expect(res.staged).toBe(1);
    expect(vendorCount()).toBe(before);
    const row = db
      .select()
      .from(adminActions)
      .all()
      .find((a) => a.action === "vendor.photo_proposed");
    const p = JSON.parse(row?.payloadJson ?? "{}");
    expect(p.stage_kind).toBe("booth_new_vendor_uncorroborated");
    expect(p.stage_reason).toMatch(/nothing but its name/);
  });

  it("the Welcome specimen stages and creates nothing", async () => {
    const before = vendorCount();
    const res = await run({ name: "Welcome", products: ["Welcome", "Welcome"] }, false);
    expect(res.autoWritten).toEqual([]);
    expect(vendorCount()).toBe(before);
    const p = JSON.parse(
      db
        .select()
        .from(adminActions)
        .all()
        .find((a) => a.action === "vendor.photo_proposed")?.payloadJson ?? "{}"
    );
    expect(p.stage_kind).toBe("booth_name_generic");
  });

  it("brand-new with a web address → may write", async () => {
    const res = await run({ website: "bluebirdstudio.com" });
    expect(res.wouldAutoWrite).toEqual(["Bluebird Studio"]);
  });

  it("brand-new with real products → may write (Momma Bear's Wild Things, 11-20)", async () => {
    const res = await run({
      name: "Momma Bear's Wild Things",
      products: ["handmade jewelry", "crocheted blankets", "spices"],
    });
    expect(res.wouldAutoWrite).toEqual(["Momma Bear's Wild Things"]);
  });

  it("an existing vendor by name links even with no other evidence (Colley Hill, 11-20)", async () => {
    seedVendor("colley", "Colley Hill Soy Candles");
    const res = await run({ name: "Colley Hill Soy Candles", products: [] });
    expect(res.wouldAutoWrite).toEqual(["Colley Hill Soy Candles"]);
  });

  it("Central Maine Power with its products still writes (11-20)", async () => {
    const res = await run({
      name: "Central Maine Power",
      products: ["electric utility", "line safety demonstration"],
    });
    expect(res.wouldAutoWrite).toEqual(["Central Maine Power"]);
  });
});
