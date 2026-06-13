/**
 * I1 vendor-enrichment — §5 safety-rule regression suite (Dev-Brief-I1 §9).
 *
 * The 12 known catches from the 2026-06-03 in-session run MUST reproduce as
 * FLAGS, never silent applies. Since Phase 1 stages everything as
 * decision='pending', the operative assertion is: the correct flag is attached
 * (a non-empty flag set is what blocks Phase-2 auto-merge), domain problems set
 * domain_hijacked + stage nothing, and junk is dropped.
 *
 * Most cases test the PURE path (extractVendorContact → buildEnrichmentResult),
 * which is exactly where flag-vs-apply is decided. A handful of DB-integration
 * tests drive processEnrichmentJob to confirm the dispatcher honors it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { vendors, vendorEnrichmentCandidates, enrichmentLog } from "../src/schema.js";
import { eq } from "drizzle-orm";
import { extractVendorContact } from "../src/enrichment/extract.js";
import { buildEnrichmentResult } from "../src/enrichment/safety-rules.js";
import { processEnrichmentJob, type EnrichmentEnv } from "../src/enrichment/dispatch.js";
import type { VendorRowForEnrichment } from "../src/enrichment/types.js";

function vendor(
  overrides: Partial<VendorRowForEnrichment> & { businessName: string }
): VendorRowForEnrichment {
  return {
    id: "v1",
    website: "https://example-vendor.com",
    contactPhone: null,
    contactEmail: null,
    socialLinks: null,
    address: null,
    city: null,
    state: null,
    description: null,
    ...overrides,
  };
}

/** All flags appearing anywhere in the result (candidates + vendor-level). */
function allFlags(r: ReturnType<typeof buildEnrichmentResult>): Set<string> {
  return new Set([...r.vendorFlags, ...r.candidates.flatMap((c) => c.flags)]);
}

function run(html: string, v: VendorRowForEnrichment, sourceUrl: string, finalUrl?: string) {
  const ex = extractVendorContact(html, sourceUrl);
  return buildEnrichmentResult(v, ex, { sourceUrl, finalUrl });
}

const jsonLd = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe("I1 safety rules — 12 known 6/3 catches reproduce as flags", () => {
  it("1. Saco River ↔ swapped FB link → social_name_mismatch", () => {
    const html = jsonLd({
      "@type": "LocalBusiness",
      sameAs: ["https://www.facebook.com/LakeStGeorgeBrewing"],
    });
    const r = run(
      html,
      vendor({ businessName: "Saco River Brewing" }),
      "https://sacoriverbrewing.com"
    );
    const social = r.candidates.find((c) => c.field === "social_links");
    expect(social).toBeTruthy();
    expect(social!.flags).toContain("social_name_mismatch");
  });

  it("2. Lake St. George ↔ swapped FB link → social_name_mismatch", () => {
    const html = jsonLd({
      "@type": "LocalBusiness",
      sameAs: ["https://www.facebook.com/SacoRiverBrewing"],
    });
    const r = run(
      html,
      vendor({ businessName: "Lake St. George Brewing" }),
      "https://lakestgeorge.com"
    );
    expect(allFlags(r)).toContain("social_name_mismatch");
  });

  it("3. Provincetown Brewing closed → business_closed flag on every candidate", () => {
    const html =
      jsonLd({ "@type": "LocalBusiness", telephone: "(508) 555-0123" }) +
      "<p>Provincetown Brewing Co is permanently closed. Thank you for years of support.</p>";
    const r = run(
      html,
      vendor({ businessName: "Provincetown Brewing Co" }),
      "https://provincetownbrewing.com"
    );
    expect(r.vendorFlags).toContain("business_closed");
    const phone = r.candidates.find((c) => c.field === "contact_phone");
    expect(phone).toBeTruthy();
    // No un-flagged proposal escapes a closed-business page.
    expect(phone!.flags).toContain("business_closed");
  });

  it("4. Own Your Own Arcade — FB-as-website → non_business_website", () => {
    const html = "<html><body>Arcade</body></html>";
    const r = run(
      html,
      vendor({ businessName: "Own Your Own Arcade" }),
      "https://www.facebook.com/OwnYourOwnArcade"
    );
    expect(r.vendorFlags).toContain("non_business_website");
    expect(r.candidates.every((c) => c.flags.includes("non_business_website"))).toBe(true);
    // No contact fields trusted from a Facebook page.
    expect(r.candidates.some((c) => c.field === "contact_phone")).toBe(false);
  });

  it("5. Carl Bettano — YachtWorld listing as website → non_business_website", () => {
    const r = run(
      "<html></html>",
      vendor({ businessName: "Carl Bettano" }),
      "https://www.yachtworld.com/yacht/2008-listing"
    );
    expect(r.vendorFlags).toContain("non_business_website");
  });

  it("6. Powder Hollow Brewing — FB-as-website → non_business_website", () => {
    const r = run(
      "<html></html>",
      vendor({ businessName: "Powder Hollow Brewing" }),
      "https://facebook.com/PowderHollowBrewing"
    );
    expect(r.vendorFlags).toContain("non_business_website");
  });

  it("7. 2 Feet Brewing — Portland→Bangor location error → city_mismatch", () => {
    const html = jsonLd({
      "@type": "LocalBusiness",
      address: { addressLocality: "Bangor", addressRegion: "ME" },
    });
    const v = vendor({ businessName: "2 Feet Brewing", city: "Portland", state: "ME" });
    const r = run(html, v, "https://2feetbrewing.com");
    expect(r.vendorFlags).toContain("city_mismatch");
    const city = r.candidates.find((c) => c.field === "city");
    expect(city).toMatchObject({ currentValue: "Portland", proposedValue: "Bangor" });
    expect(city!.flags).toContain("city_mismatch");
  });

  it("8. Regulator Marine — CT→NC location error → state_mismatch", () => {
    const html = jsonLd({ "@type": "Organization", address: { addressRegion: "NC" } });
    const v = vendor({ businessName: "Regulator Marine", state: "CT" });
    const r = run(html, v, "https://regulatormarine.com");
    expect(r.vendorFlags).toContain("state_mismatch");
    const st = r.candidates.find((c) => c.field === "state");
    expect(st).toMatchObject({ currentValue: "CT", proposedValue: "NC" });
  });

  it("9. Parked domain (Sedo lander) → domain_parked, stage nothing", () => {
    const html = "<html><body>This domain is parked free, courtesy of Sedo.</body></html>";
    const r = run(html, vendor({ businessName: "Old Vendor" }), "https://oldvendor.com");
    expect(r.domainProblem).toBe("domain_parked");
    expect(r.candidates).toHaveLength(0);
  });

  it("10. For-sale lander (title) → domain_for_sale, stage nothing", () => {
    const html =
      "<html><head><title>This domain is for sale</title></head><body>Buy this domain</body></html>";
    const r = run(html, vendor({ businessName: "Defunct Vendor" }), "https://defunct.com");
    expect(r.domainProblem).toBe("domain_for_sale");
    expect(r.candidates).toHaveLength(0);
  });

  it("11. Placeholder email (noreply@example.com) → dropped, real phone still proposed", () => {
    const html = jsonLd({
      "@type": "LocalBusiness",
      email: "noreply@example.com",
      telephone: "(207) 555-1212",
    });
    const r = run(html, vendor({ businessName: "Acme Co", state: "ME" }), "https://acme.com");
    expect(r.candidates.some((c) => c.field === "contact_email")).toBe(false); // junk dropped
    const phone = r.candidates.find((c) => c.field === "contact_phone");
    expect(phone).toBeTruthy();
    expect(phone!.flags).toHaveLength(0); // 207 = ME, no mismatch
  });

  it("12. Malware redirect to known-bad host → domain_malware_redirect", () => {
    const r = run(
      "<html><body>hi</body></html>",
      vendor({ businessName: "Two Feet" }),
      "https://twofeetbeer.com",
      "https://bodis.com/park"
    );
    expect(r.domainProblem).toBe("domain_malware_redirect");
    expect(r.candidates).toHaveLength(0);
  });

  // --- extra rule coverage ---

  it("area-code vs state mismatch → area_code_mismatch", () => {
    const html = jsonLd({ "@type": "LocalBusiness", telephone: "(203) 555-0000" });
    const r = run(html, vendor({ businessName: "Coastal Co", state: "ME" }), "https://coastal.com");
    expect(allFlags(r)).toContain("area_code_mismatch");
  });

  it("POSITIVE CONTROL: clean LocalBusiness → fields proposed with NO flags", () => {
    const html = jsonLd({
      "@type": "LocalBusiness",
      telephone: "(207) 555-0100",
      email: "hello@kingfieldwoodworks.com",
      sameAs: ["https://www.facebook.com/kingfieldwoodworks"],
      address: { streetAddress: "1 Main St", addressLocality: "Kingfield", addressRegion: "ME" },
    });
    const r = run(
      html,
      vendor({ businessName: "Kingfield Woodworks" }),
      "https://kingfieldwoodworks.com"
    );
    expect(r.domainProblem).toBeNull();
    expect(allFlags(r).size).toBe(0); // no over-flagging on a clean site
    const fields = r.candidates.map((c) => c.field).sort();
    expect(fields).toEqual([
      "address",
      "city",
      "contact_email",
      "contact_phone",
      "social_links",
      "state",
    ]);
  });

  it("fill-empty-only: a non-empty field is never proposed", () => {
    const html = jsonLd({
      "@type": "LocalBusiness",
      telephone: "(207) 555-9999",
      email: "new@v.com",
    });
    const v = vendor({ businessName: "Filled Co", contactPhone: "(207) 555-0000" });
    const r = run(html, v, "https://filledco.com");
    expect(r.candidates.some((c) => c.field === "contact_phone")).toBe(false); // already set
    expect(r.candidates.some((c) => c.field === "contact_email")).toBe(true); // was empty
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration (real D1, mocked fetch)
// ---------------------------------------------------------------------------
function mockFetchHtml(html: string): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  return () => (globalThis.fetch = orig);
}

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as EnrichmentEnv;

async function insertVendor(db: TestDb, over: Record<string, unknown>): Promise<string> {
  const id = (over.id as string) ?? `v-${Math.floor(Math.random() * 1e9)}`;
  await db.insert(vendors).values({
    id,
    userId: `u-${id}`,
    businessName: (over.businessName as string) ?? "Test Vendor",
    slug: (over.slug as string) ?? `slug-${id}`,
    ...over,
  } as never);
  return id;
}

describe("I1 dispatcher integration", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("parked domain → sets vendors.domain_hijacked, stages no candidates", async () => {
    const { db } = createTestDb();
    const id = await insertVendor(db, { businessName: "Parked Co", website: "https://parked.com" });
    restore = mockFetchHtml("<html><body>Domain parking by Sedo</body></html>");

    const summary = await processEnrichmentJob(db, ENV, {
      vendorId: id,
      jobRunId: "j1",
      dryRun: true,
    });

    expect(summary.outcome).toBe("domain_problem");
    const [row] = await db
      .select({ h: vendors.domainHijacked })
      .from(vendors)
      .where(eq(vendors.id, id));
    expect(row.h).toBe(true);
    const staged = await db
      .select()
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.vendorId, id));
    expect(staged).toHaveLength(0);
  });

  it("dry-run stages candidates WITHOUT touching the live vendor row", async () => {
    const { db } = createTestDb();
    const id = await insertVendor(db, {
      businessName: "Kingfield Woodworks",
      website: "https://kingfieldwoodworks.com",
    });
    restore = mockFetchHtml(
      jsonLd({
        "@type": "LocalBusiness",
        telephone: "(207) 555-0100",
        email: "hello@kingfieldwoodworks.com",
      })
    );

    const summary = await processEnrichmentJob(db, ENV, {
      vendorId: id,
      jobRunId: "j2",
      dryRun: true,
    });

    expect(summary.outcome).toBe("staged");
    const staged = await db
      .select()
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.vendorId, id));
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((s) => s.decision === "pending")).toBe(true);
    // Live row untouched.
    const [v] = await db
      .select({ p: vendors.contactPhone, e: vendors.contactEmail })
      .from(vendors)
      .where(eq(vendors.id, id));
    expect(v.p).toBeNull();
    expect(v.e).toBeNull();
  });

  it("fetch failure stamps enrichment_attempted_at + logs failure (acks, no throw)", async () => {
    const { db } = createTestDb();
    const id = await insertVendor(db, {
      businessName: "Dead Site",
      website: "https://dead.example",
    });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    restore = () => (globalThis.fetch = orig);

    const summary = await processEnrichmentJob(db, ENV, {
      vendorId: id,
      jobRunId: "j3",
      dryRun: true,
    });

    expect(summary.outcome).toBe("fetch_failed");
    const [v] = await db
      .select({ a: vendors.enrichmentAttemptedAt })
      .from(vendors)
      .where(eq(vendors.id, id));
    expect(v.a).not.toBeNull(); // rotates the cron forward — no infinite re-pick
    const logs = await db.select().from(enrichmentLog).where(eq(enrichmentLog.targetId, id));
    expect(logs.some((l) => l.status === "failure")).toBe(true);
  });

  it("live auto-merge applies un-flagged fills + leaves flagged conflicts staged", async () => {
    const { db } = createTestDb();
    const id = await insertVendor(db, {
      businessName: "Merge Co",
      website: "https://mergeco.com",
      city: "Portland",
      state: "ME",
    });
    // Clean phone/email (un-flagged) + a Bangor address that conflicts with the
    // stored Portland city (flagged → must NOT auto-merge).
    restore = mockFetchHtml(
      jsonLd({
        "@type": "LocalBusiness",
        telephone: "(207) 555-7777",
        email: "team@mergeco.com",
        address: { addressLocality: "Bangor", addressRegion: "ME" },
      })
    );

    const summary = await processEnrichmentJob(db, ENV, {
      vendorId: id,
      jobRunId: "j4",
      dryRun: false,
    });

    expect(summary.outcome).toBe("merged");
    const [v] = await db
      .select({ p: vendors.contactPhone, e: vendors.contactEmail, city: vendors.city })
      .from(vendors)
      .where(eq(vendors.id, id));
    expect(v.p).toBe("(207) 555-7777"); // un-flagged fill applied
    expect(v.e).toBe("team@mergeco.com");
    expect(v.city).toBe("Portland"); // conflict NOT applied
    // The flagged city candidate remains pending for manual review.
    const pending = await db
      .select()
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.vendorId, id));
    expect(pending.some((c) => c.proposedField === "city" && c.decision === "pending")).toBe(true);
  });
});
