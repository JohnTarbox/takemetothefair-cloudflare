/**
 * OPE-249 review bounce (2026-09-23) — the four items the return listed.
 *
 * Specimens are the prod candidates: #1955/#2875 (maine-grain-alliance, a
 * twitter SEARCH url with an undecoded `&#038;`), #2613 (childrens-museum-of-
 * new-hampshire, LinkedIn slug with `&#039;`), #1901/#2843 (a human rejection
 * that auto-merged on the next run).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { extractVendorContact } from "../src/enrichment/extract.js";
import { extractPromoterSignals } from "../src/enrichment/promoter-extract.js";
import { applyHumanVeto } from "../src/enrichment/human-veto.js";

const a = (href: string) => `<a href="${href}">x</a>`;
const socials = (html: string) =>
  extractVendorContact(html, "https://org.example.com").social?.value ?? {};

// ─────────────────────────────────────────────────────────────────────────
describe("social URLs — entity-decoded, and only accounts", () => {
  it("#2875: a twitter SEARCH url is not an account (with the entity it arrived with)", () => {
    const s = socials(
      a("https://www.facebook.com/mainegrainalliance") +
        a("https://twitter.com/search?q=%40kneading_conf&#038;src=typed_query") +
        a("https://www.instagram.com/mainegrainalliance/")
    );
    expect(s).toEqual({
      facebook: "https://www.facebook.com/mainegrainalliance",
      instagram: "https://www.instagram.com/mainegrainalliance/",
    });
  });

  it("#2613: a LinkedIn slug's `&#039;` is decoded, never stored as an entity", () => {
    const s = socials(
      a("https://www.linkedin.com/company/the-children&#039;s-museum-of-new-hampshire/")
    );
    expect(s.linkedin).toBeDefined();
    expect(s.linkedin).not.toMatch(/&#0?39;|&amp;/);
    expect(decodeURIComponent(s.linkedin)).toContain("the-children's-museum-of-new-hampshire");
  });

  it("hashtag feeds and Twitter's internal /i/ routes are not accounts", () => {
    expect(socials(a("https://x.com/hashtag/fryeburgfair"))).toEqual({});
    expect(socials(a("https://twitter.com/i/lists/12345"))).toEqual({});
  });

  it("a signed / expiring URL is an asset link, not a profile", () => {
    expect(socials(a("https://www.facebook.com/somefair?oh=00_AbC&amp;oe=66F1A2B3"))).toEqual({});
  });

  it("tracking query is dropped from a profile; Facebook's numeric profile keeps its id", () => {
    const s = socials(
      a("https://www.instagram.com/squaremarket/?hl=en") +
        a("https://www.facebook.com/profile.php?id=100064123456789")
    );
    expect(s.instagram).toBe("https://www.instagram.com/squaremarket/");
    expect(s.facebook).toBe("https://www.facebook.com/profile.php?id=100064123456789");
  });

  it("the PROMOTER lane gets the same answer (one extractor, both lanes)", () => {
    const html =
      a("https://www.facebook.com/mainegrainalliance") +
      a("https://twitter.com/search?q=%40kneading_conf&#038;src=typed_query");
    const p = extractPromoterSignals(html, "https://mainegrain.org");
    expect(JSON.parse(p.socialLinks!.value)).toEqual({
      facebook: "https://www.facebook.com/mainegrainalliance",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("applyHumanVeto", () => {
  const prop = (field: string, v: string) => ({ field, proposedValue: v, flags: [] as string[] });

  it("flags a value a human rejected or reverted, and only that field+value", () => {
    const ps = [prop("social_links", "A"), prop("social_links", "B"), prop("contact_phone", "A")];
    applyHumanVeto(ps, [
      { field: "social_links", value: " A ", decision: "rejected" },
      { field: "contact_phone", value: "Z", decision: "reverted" },
    ]);
    expect(ps.map((p) => p.flags)).toEqual([["previously_rejected"], [], []]);
  });

  it("a rejection outranks a revert of the same value; approvals veto nothing", () => {
    const ps = [prop("f", "v"), prop("g", "w")];
    applyHumanVeto(ps, [
      { field: "f", value: "v", decision: "reverted" },
      { field: "f", value: "v", decision: "rejected" },
      { field: "g", value: "w", decision: "approved" },
    ]);
    expect(ps[0].flags).toEqual(["previously_rejected"]);
    expect(ps[1].flags).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("#1955 → #2875: a human REJECTION survives the next live run (promoter lane, real dispatcher)", () => {
  const ENV = {
    CLOUDFLARE_ACCOUNT_ID: "test",
    MAIN_APP_URL: "https://meetmeatthefair.com",
    INTERNAL_API_KEY: "k",
  } as unknown as PromoterEnrichmentEnv;
  const HAS_PHONE = `<script type="application/ld+json">${JSON.stringify({
    "@type": "Organization",
    telephone: "(207) 555-0100",
  })}</script>`;
  let db: TestDb;
  let server: CapturingMcpServer;
  let indexNow: ReturnType<typeof mockIndexNowFetch>;
  let restore: (() => void) | null = null;

  beforeEach(async () => {
    ({ db } = createTestDb());
    indexNow = mockIndexNowFetch();
    server = new CapturingMcpServer();
    registerAdminTools(server as never, db, { userId: "u-admin", role: "ADMIN" }, ENV as never);
    await db.insert(promoters).values({
      id: "p1",
      companyName: "Weston Craft Show",
      slug: "weston-craft-show",
      website: "https://barren.example.com",
      enrichmentStatus: "NEEDS_ENRICHMENT",
    } as never);
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("barren.example.com")) {
        return new Response(HAS_PHONE, { status: 200, headers: { "content-type": "text/html" } });
      }
      return orig(input, init);
    }) as typeof fetch;
    restore = () => (globalThis.fetch = orig);
  });
  afterEach(() => {
    restore?.();
    indexNow.restore();
  });

  const render = (dryRun: boolean) =>
    processPromoterEnrichmentJob(db, ENV, {
      promoterId: "p1",
      jobRunId: `j-${Math.random()}`,
      dryRun,
    });
  const phones = () =>
    db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.proposedField, "contact_phone"));

  it("ACCEPTANCE: rejected once → the next LIVE render stages it flagged and does NOT apply it", async () => {
    await render(true); // stage for review, nothing applied
    const [c] = await phones();
    expect(c.decision).toBe("pending");
    const r = (await server.invoke("review_promoter_enrichment_candidate", {
      candidate_id: c.id,
      action: "reject",
    })) as { isError?: boolean };
    expect(r.isError).not.toBe(true);
    expect((await phones())[0].decision).toBe("rejected");

    await render(false); // a live run, where auto-apply is ON
    const p = (await db.select().from(promoters).where(eq(promoters.id, "p1")))[0];
    expect(p.contactPhone).toBeNull();
    const pending = (await phones()).find((x) => x.decision === "pending");
    expect(pending?.proposedValue).toBe(c.proposedValue);
    expect(JSON.parse(pending!.flags)).toContain("previously_rejected");
    expect((await phones()).some((x) => x.decision === "auto_merged")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the VENDOR lane honors a human rejection too (same defect, same helper)", () => {
  it("ACCEPTANCE: a rejected phone is not auto-merged on the next live run; an un-rejected email still is", async () => {
    const { processEnrichmentJob } = await import("../src/enrichment/dispatch.js");
    const { vendors, vendorEnrichmentCandidates } = await import("../src/schema.js");
    const { db } = createTestDb();
    await db.insert(vendors).values({
      id: "v1",
      userId: "u-v1",
      businessName: "Merge Co",
      slug: "merge-co",
      website: "https://mergeco.com",
      city: "Bangor",
      state: "ME",
    } as never);
    await db.insert(vendorEnrichmentCandidates).values({
      vendorId: "v1",
      jobRunId: "old",
      proposedField: "contact_phone",
      currentValue: null,
      proposedValue: "(207) 265-4318",
      sourceUrl: "https://mergeco.com",
      extractionMethod: "jsonld",
      fetchMethod: "standard",
      confidence: 0.9,
      flags: "[]",
      createdAt: new Date(),
      decision: "rejected",
    } as never);
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "LocalBusiness",
          telephone: "(207) 265-4318",
          email: "team@mergeco.com",
          address: { addressLocality: "Bangor", addressRegion: "ME" },
        })}</script>`,
        { status: 200, headers: { "content-type": "text/html" } }
      )) as typeof fetch;
    try {
      await processEnrichmentJob(
        db,
        { CLOUDFLARE_ACCOUNT_ID: "t", MAIN_APP_URL: "https://x", INTERNAL_API_KEY: "k" } as never,
        {
          vendorId: "v1",
          jobRunId: "j-live",
          dryRun: false,
        }
      );
    } finally {
      globalThis.fetch = orig;
    }
    const [v] = await db.select().from(vendors).where(eq(vendors.id, "v1"));
    expect(v.contactPhone).toBeNull();
    expect(v.contactEmail).toBe("team@mergeco.com"); // control: the lane still merges
    const rows = await db
      .select()
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.vendorId, "v1"));
    const phone = rows.find((r) => r.proposedField === "contact_phone" && r.decision === "pending");
    expect(JSON.parse(phone!.flags)).toContain("previously_rejected");
  });
});
