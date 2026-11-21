/**
 * OPE-1694 — a booth sign reading "Maine CardWorks.com" created a duplicate of
 * Maine Cardworks Inc (website https://www.mainecardworks.com) because the
 * vendor write path never looked at the domain. These pin the domain-first
 * match on the pure extractor, on the shared write tail, and on the pipeline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  adminActions,
  eventVendors,
  events,
  promoters,
  users,
  vendors,
  orgDomains,
} from "../src/schema.js";
import {
  createOrLinkVendor,
  extractSignDomain,
  normalizeSignDomain,
  type VendorLinkDb,
} from "@takemetothefair/vendor-linking";
import { autoWriteBooths, BOOTH_AUTOWRITTEN_ACTION } from "../src/photo/auto-write.js";
import { runBoothPipeline, type BoothPipelineEnv } from "../src/photo/booth-pipeline.js";
import type { Db } from "../src/db.js";
import type { BoothIdentification } from "../src/photo/vision.js";

describe("extractSignDomain — pure", () => {
  it("finds a domain embedded in the name and cleans the name (the specimen)", () => {
    // Printed MaineCardWorks.com, read with a space. Both are tried, joined first.
    const sd = extractSignDomain("Maine CardWorks.com", null);
    expect(sd.domain).toBe("cardworks.com");
    expect(sd.candidates).toEqual(["mainecardworks.com", "cardworks.com"]);
    expect(sd.source).toBe("name");
    expect(sd.cleanedName).toBe("Maine CardWorks");
  });

  it("prefers the website field (a domain on a separate line of the sign)", () => {
    const sd = extractSignDomain("Maine CardWorks", "www.MaineCardworks.com");
    expect(sd.domain).toBe("mainecardworks.com");
    expect(sd.source).toBe("website");
    expect(sd.cleanedName).toBe("Maine CardWorks");
  });

  it("normalises scheme, www, case and path", () => {
    for (const raw of [
      "https://www.mainecardworks.com",
      "http://mainecardworks.com/shop/cards",
      "WWW.MAINECARDWORKS.COM",
      "MaineCardWorks.com",
      "shop.mainecardworks.com",
    ]) {
      expect(normalizeSignDomain(raw)).toBe("mainecardworks.com");
    }
  });

  it("strips a full URL out of a name", () => {
    const sd = extractSignDomain("Colley Hill https://www.colleyhill.com", null);
    expect(sd.domain).toBe("colleyhill.com");
    expect(sd.candidates).toEqual(["colleyhill.com"]); // never joined across https://
    expect(sd.cleanedName).toBe("Colley Hill");
  });

  it("does not read a dotted name with a fake suffix as a domain", () => {
    for (const name of ["St.Louis Bakery", "Mr.Smith's Fudge", "J.R. Woodworks"]) {
      const sd = extractSignDomain(name, null);
      expect(sd.domain).toBeNull();
      expect(sd.cleanedName).toBe(name);
    }
  });

  it("flags a marketplace domain as non-ownable", () => {
    const sd = extractSignDomain("Bink Crafts", "etsy.com/shop/binkcrafts");
    expect(sd.domain).toBe("etsy.com");
    expect(sd.nonOwnable).toBe(true);
  });

  it("returns no domain for a plain name", () => {
    expect(extractSignDomain("Momma Bear's Wild Things", null)).toEqual({
      domain: null,
      candidates: [],
      source: null,
      nonOwnable: false,
      cleanedName: "Momma Bear's Wild Things",
    });
  });
});

let db: TestDb;
const deps = {
  actorUserId: null,
  recomputeVendorCompleteness: async () => undefined,
  logEnrichment: async () => undefined,
};

function seedVendor(id: string, businessName: string, website: string | null, extra = {}) {
  db.insert(users)
    .values({ id: `u-${id}`, email: `${id}@example.test`, role: "VENDOR" } as never)
    .run();
  db.insert(vendors)
    .values({ id, userId: `u-${id}`, businessName, slug: id, website, ...extra } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "ev1", name: "CMP Fair", slug: "cmp-fair", promoterId: "p1", status: "APPROVED" })
    .run();
});

const link = (businessName: string, website: string | null = null) =>
  createOrLinkVendor(
    db as unknown as VendorLinkDb,
    { eventId: "ev1", businessName, website, status: "CONFIRMED", matchByDomain: true },
    deps
  );

const vendorCount = () => db.select().from(vendors).all().length;

describe("createOrLinkVendor({ matchByDomain })", () => {
  it("links the vendor whose website carries the sign's domain — creates nothing", async () => {
    seedVendor("adc1d1b4", "Maine Cardworks Inc", "https://www.mainecardworks.com");
    const before = vendorCount();
    const res = await link("MaineCardWorks.com");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.vendorId).toBe("adc1d1b4");
    expect(res.wasCreated).toBe(false);
    expect(res.matchBasis).toBe("domain");
    expect(res.matchedDomain).toBe("mainecardworks.com");
    expect(vendorCount()).toBe(before);
    const ev = db.select().from(eventVendors).where(eq(eventVendors.vendorId, "adc1d1b4")).all();
    expect(ev).toHaveLength(1);
  });

  it("links the specimen as the model read it: 'Maine CardWorks.com', with a space", async () => {
    seedVendor("adc1d1b4", "Maine Cardworks Inc", "https://www.mainecardworks.com");
    const res = await link("Maine CardWorks.com");
    expect(res.ok && res.vendorId).toBe("adc1d1b4");
    expect(res.ok && res.matchedDomain).toBe("mainecardworks.com");
  });

  it("matches a domain held only on org_domains", async () => {
    seedVendor("v-org", "Hearth & Home", null);
    db.insert(orgDomains)
      .values({
        entityType: "vendor",
        entityId: "v-org",
        domain: "hearthhomeme.com",
        status: "active",
        method: "operator",
        addedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const res = await link("Hearth Home", "https://hearthhomeme.com");
    expect(res.ok && res.vendorId).toBe("v-org");
  });

  it("refuses to write when two live vendors carry the domain", async () => {
    seedVendor("a", "Twin One", "https://twins.com");
    seedVendor("b", "Twin Two", "http://www.twins.com/about");
    const before = vendorCount();
    const res = await link("Twins.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("domain_ambiguous");
    expect(res.domainCandidates?.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(vendorCount()).toBe(before);
  });

  it("counts a merged-away duplicate once, as its keeper", async () => {
    seedVendor("keeper", "Maine Cardworks Inc", "https://www.mainecardworks.com");
    seedVendor("dupe", "Maine CardWorks.com", "mainecardworks.com", {
      redirectToVendorId: "keeper",
    });
    const res = await link("Maine CardWorks.com");
    expect(res.ok && res.vendorId).toBe("keeper");
  });

  it("no match: creates with the domain in website and NOT in business_name", async () => {
    const res = await link("Maine CardWorks.com");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wasCreated).toBe(true);
    expect(res.matchBasis).toBeNull();
    const [v] = db.select().from(vendors).where(eq(vendors.id, res.vendorId)).all();
    expect(v.businessName).toBe("Maine CardWorks");
    expect(v.website).toBe("https://cardworks.com");
  });

  it("no domain on the sign: falls through to name matching", async () => {
    seedVendor("colley", "Colley Hill Soy Candles", null);
    const res = await link("Colley Hill Soy Candles");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.vendorId).toBe("colley");
    expect(res.matchBasis).toBe("name");
    expect(res.matchedDomain).toBeNull();
  });

  it("is off by default — other callers keep today's behaviour", async () => {
    seedVendor("adc1d1b4", "Maine Cardworks Inc", "https://www.mainecardworks.com");
    const res = await createOrLinkVendor(
      db as unknown as VendorLinkDb,
      { eventId: "ev1", businessName: "Totally Different Name", website: "mainecardworks.com" },
      deps
    );
    expect(res.ok && res.wasCreated).toBe(true);
  });
});

const booth = (over: Partial<BoothIdentification> = {}): BoothIdentification => ({
  kind: "booth",
  businessName: "Maine CardWorks.com",
  performerName: null,
  signText: null,
  website: null,
  products: ["cards"],
  confidence: 1,
  rationale: "sign on the table",
  identifiableMinor: false,
  ...over,
});

describe("booth-photo auto-write — the specimen", () => {
  it("links Maine Cardworks Inc, creates no vendor, and logs match_basis: domain", async () => {
    seedVendor("adc1d1b4", "Maine Cardworks Inc", "https://www.mainecardworks.com");
    const before = vendorCount();
    const out = await autoWriteBooths({}, db as unknown as Db, "ie1", "ev1", [
      { photoKey: "k1", photoName: "a.jpg", id: booth({ businessName: "MaineCardWorks.com" }) },
    ]);
    expect(out[0].vendorId).toBe("adc1d1b4");
    expect(out[0].wasCreated).toBe(false);
    expect(out[0].matchBasis).toBe("domain");
    expect(vendorCount()).toBe(before);
    const [marker] = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, BOOTH_AUTOWRITTEN_ACTION))
      .all();
    const p = JSON.parse(marker.payloadJson ?? "{}");
    expect(p.match_basis).toBe("domain");
    expect(p.matched_domain).toBe("mainecardworks.com");
    expect(p.vendor_id).toBe("adc1d1b4");
  });
});

describe("runBoothPipeline — domain check before the dry-run boundary", () => {
  const reply = (over: Record<string, unknown>) => ({
    response: JSON.stringify({
      kind: "booth",
      name: "MaineCardWorks.com",
      website: null,
      products: ["cards"],
      confidence: 1,
      rationale: "sign",
      identifiable_minor: false,
      mounted_on: "vendor_table_or_tent",
      ...over,
    }),
  });
  const env = (r: unknown): BoothPipelineEnv => ({
    AI: { run: async () => r },
    VENDOR_ASSETS: {
      get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
    } as unknown as R2Bucket,
    PHOTO_VISION_ENABLED: "true",
    PHOTO_AUTOWRITE_ENABLED: "true",
  });
  const photos = [{ key: "inbound-attachments/s/0.jpg", name: "0.jpg" }];

  it("dry run reports the link to the existing vendor and writes nothing", async () => {
    seedVendor("adc1d1b4", "Maine Cardworks Inc", "https://www.mainecardworks.com");
    const before = vendorCount();
    const res = await runBoothPipeline(env(reply({})), db as unknown as Db, "ie1", "ev1", photos, {
      dryRun: true,
    });
    expect(res.wouldLinkByDomain).toEqual([
      {
        businessName: "MaineCardWorks.com",
        domain: "mainecardworks.com",
        vendorId: "adc1d1b4",
        vendorName: "Maine Cardworks Inc",
      },
    ]);
    expect(vendorCount()).toBe(before);
  });

  it("stages (does not write) when the domain matches two vendors", async () => {
    seedVendor("a", "Card One", "https://mainecardworks.com");
    seedVendor("b", "Card Two", "https://www.mainecardworks.com");
    const before = vendorCount();
    const res = await runBoothPipeline(env(reply({})), db as unknown as Db, "ie1", "ev1", photos);
    expect(res.autoWritten).toEqual([]);
    expect(res.staged).toBe(1);
    expect(vendorCount()).toBe(before);
    const rows = db.select().from(adminActions).all();
    const staged = rows.find((r) => r.action === "vendor.photo_proposed");
    const p = JSON.parse(staged?.payloadJson ?? "{}");
    expect(p.stage_kind).toBe("booth_domain_ambiguous");
    expect(p.matched_domain).toBe("mainecardworks.com");
    expect(p.domain_candidates).toHaveLength(2);
  });
});
