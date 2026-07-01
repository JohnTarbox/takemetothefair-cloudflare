/**
 * OPE-36 promoter pre-extraction — extraction + dispatcher suite.
 *
 *   - classifyPromoterImage: og:image hero-vs-logo classification
 *   - extractPromoterSignals: contact / social / description / og:image mapping
 *   - processPromoterEnrichmentJob: candidate staging, auto-apply gating,
 *     BLOCKED on fetch fail, NO_SOURCE on no website
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { promoters, promoterEnrichmentCandidates, enrichmentLog } from "../src/schema.js";
import { classifyPromoterImage } from "../src/enrichment/promoter-image.js";
import { extractPromoterSignals } from "../src/enrichment/promoter-extract.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

const jsonLd = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

/** Minimal PNG whose header encodes the given dimensions (parsePngDimensions
 *  reads width at byte 16, height at byte 20, both big-endian). */
function makePng(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return b;
}

/** Route the page fetch to HTML and any image fetch (by URL substring) to bytes. */
function mockSite(html: string, images: Record<string, Uint8Array> = {}): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const [key, bytes] of Object.entries(images)) {
      if (u.includes(key)) {
        return new Response(bytes, { status: 206, headers: { "content-type": "image/png" } });
      }
    }
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return () => (globalThis.fetch = orig);
}

async function insertPromoter(db: TestDb, over: Record<string, unknown>): Promise<string> {
  const id = (over.id as string) ?? `p-${Math.floor(Math.random() * 1e9)}`;
  await db.insert(promoters).values({
    id,
    companyName: (over.companyName as string) ?? "Test Promoter",
    slug: (over.slug as string) ?? `slug-${id}`,
    ...over,
  } as never);
  return id;
}

// ---------------------------------------------------------------------------
// classifyPromoterImage (pure)
// ---------------------------------------------------------------------------
describe("classifyPromoterImage — hero vs logo", () => {
  it("wide image (AR ≥ 1.3), no logo token → hero (auto-apply eligible)", () => {
    const r = classifyPromoterImage("https://cdn.example.com/banner.png", {
      width: 1200,
      height: 600,
    });
    expect(r.classification).toBe("hero");
    expect(r.heroConfident).toBe(true);
  });

  it("small square image → logo (looksLikeLogo long-edge gate)", () => {
    const r = classifyPromoterImage("https://cdn.example.com/pic.png", { width: 300, height: 300 });
    expect(r.classification).toBe("logo");
    expect(r.heroConfident).toBe(false);
  });

  it("wide but URL has a logo token → logo (never a hero)", () => {
    const r = classifyPromoterImage("https://cdn.example.com/site-logo.png", {
      width: 1600,
      height: 500,
    });
    expect(r.classification).toBe("logo");
  });

  it("wide but large square (AR 1.0) → logo", () => {
    const r = classifyPromoterImage("https://cdn.example.com/pic.png", {
      width: 1000,
      height: 1000,
    });
    expect(r.classification).toBe("logo");
  });

  it("un-measurable image (null dims) → logo, not hero-confident", () => {
    const r = classifyPromoterImage("https://cdn.example.com/banner.png", null);
    expect(r.classification).toBe("logo");
    expect(r.heroConfident).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractPromoterSignals (pure)
// ---------------------------------------------------------------------------
describe("extractPromoterSignals — signal mapping", () => {
  it("maps og:image, contact, social, and description", () => {
    const html =
      `<head><meta property="og:image" content="https://cdn.acme.com/banner.png">` +
      `<meta name="description" content="Acme Promotions runs the best regional fairs."></head>` +
      jsonLd({
        "@type": "Organization",
        telephone: "(207) 555-0100",
        email: "hello@acmepromotions.com",
        sameAs: ["https://www.facebook.com/acmepromotions"],
      });
    const ex = extractPromoterSignals(html, "https://acmepromotions.com");
    expect(ex.ogImage).toBe("https://cdn.acme.com/banner.png");
    expect(ex.contactPhone?.value).toBe("(207) 555-0100");
    expect(ex.contactEmail?.value).toBe("hello@acmepromotions.com");
    expect(ex.description?.value).toContain("Acme Promotions");
    const social = JSON.parse(ex.socialLinks!.value) as Record<string, string>;
    expect(social.facebook).toBe("https://www.facebook.com/acmepromotions");
  });

  it("resolves a relative og:image against the source URL", () => {
    const html = `<meta property="og:image" content="/img/hero.png">`;
    const ex = extractPromoterSignals(html, "https://acmepromotions.com/about");
    expect(ex.ogImage).toBe("https://acmepromotions.com/img/hero.png");
  });

  it("falls back to twitter:image when og:image is absent", () => {
    const html = `<meta name="twitter:image" content="https://cdn.acme.com/tw.png">`;
    const ex = extractPromoterSignals(html, "https://acmepromotions.com");
    expect(ex.ogImage).toBe("https://cdn.acme.com/tw.png");
  });
});

// ---------------------------------------------------------------------------
// processPromoterEnrichmentJob (real D1, mocked fetch)
// ---------------------------------------------------------------------------
describe("processPromoterEnrichmentJob", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("NO_SOURCE when the promoter has no website (stamps attempt, stages nothing)", async () => {
    const { db } = createTestDb();
    const id = await insertPromoter(db, { companyName: "No Site", website: null });

    const summary = await processPromoterEnrichmentJob(db, ENV, {
      promoterId: id,
      jobRunId: "j-nosite",
      dryRun: true,
    });

    expect(summary.outcome).toBe("no_source");
    const [p] = await db
      .select({ s: promoters.enrichmentStatus, a: promoters.enrichmentAttemptedAt })
      .from(promoters)
      .where(eq(promoters.id, id));
    expect(p.s).toBe("NO_SOURCE");
    expect(p.a).not.toBeNull();
    const staged = await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.promoterId, id));
    expect(staged).toHaveLength(0);
  });

  it("BLOCKED (host_gated) when the website host is SSRF-blocked", async () => {
    const { db } = createTestDb();
    const id = await insertPromoter(db, {
      companyName: "Local Only",
      website: "https://localhost/",
    });

    const summary = await processPromoterEnrichmentJob(db, ENV, {
      promoterId: id,
      jobRunId: "j-blocked",
      dryRun: true,
    });

    expect(summary.outcome).toBe("blocked");
    expect(summary.blockedReason).toBe("host_gated");
    const [p] = await db
      .select({ s: promoters.enrichmentStatus, r: promoters.enrichmentBlockedReason })
      .from(promoters)
      .where(eq(promoters.id, id));
    expect(p.s).toBe("BLOCKED");
    expect(p.r).toBe("host_gated");
    const logs = await db.select().from(enrichmentLog).where(eq(enrichmentLog.targetId, id));
    expect(logs.some((l) => l.status === "failure")).toBe(true);
  });

  it("dry-run stages candidates WITHOUT touching the live promoter row", async () => {
    const { db } = createTestDb();
    const id = await insertPromoter(db, {
      companyName: "Acme Promotions",
      website: "https://acmepromotions.com",
    });
    const html =
      `<meta property="og:image" content="https://cdn.acme.com/banner.png">` +
      `<meta name="description" content="Acme Promotions runs the best regional fairs.">` +
      jsonLd({
        "@type": "Organization",
        telephone: "(207) 555-0100",
        email: "hello@acmepromotions.com",
        sameAs: ["https://www.facebook.com/acmepromotions"],
      });
    restore = mockSite(html, { "banner.png": makePng(1200, 600) });

    const summary = await processPromoterEnrichmentJob(db, ENV, {
      promoterId: id,
      jobRunId: "j-dry",
      dryRun: true,
    });

    expect(summary.outcome).toBe("staged");
    const staged = await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.promoterId, id));
    const fields = staged.map((s) => s.proposedField).sort();
    expect(fields).toEqual([
      "contact_email",
      "contact_phone",
      "description",
      "hero",
      "social_links",
    ]);
    expect(staged.every((s) => s.decision === "pending")).toBe(true);
    // Live row untouched.
    const [p] = await db
      .select({ hero: promoters.heroImageUrl, email: promoters.contactEmail })
      .from(promoters)
      .where(eq(promoters.id, id));
    expect(p.hero).toBeNull();
    expect(p.email).toBeNull();
  });

  it("live run auto-applies high-confidence fills + recomputes enrichment", async () => {
    const { db } = createTestDb();
    const id = await insertPromoter(db, {
      companyName: "Acme Promotions",
      website: "https://acmepromotions.com",
    });
    const html =
      `<meta property="og:image" content="https://cdn.acme.com/banner.png">` +
      `<meta name="description" content="Acme Promotions runs the best regional fairs.">` +
      jsonLd({
        "@type": "Organization",
        telephone: "(207) 555-0100",
        email: "hello@acmepromotions.com",
        sameAs: ["https://www.facebook.com/acmepromotions"],
      });
    restore = mockSite(html, { "banner.png": makePng(1200, 600) });

    const summary = await processPromoterEnrichmentJob(db, ENV, {
      promoterId: id,
      jobRunId: "j-live",
      dryRun: false,
    });

    expect(summary.outcome).toBe("merged");
    const [p] = await db
      .select({
        hero: promoters.heroImageUrl,
        email: promoters.contactEmail,
        phone: promoters.contactPhone,
        social: promoters.socialLinks,
        desc: promoters.description,
        status: promoters.enrichmentStatus,
        last: promoters.lastEnrichedAt,
      })
      .from(promoters)
      .where(eq(promoters.id, id));
    expect(p.hero).toBe("https://cdn.acme.com/banner.png");
    expect(p.email).toBe("hello@acmepromotions.com");
    expect(p.phone).toBe("(207) 555-0100");
    expect(p.desc).toContain("Acme Promotions");
    expect(JSON.parse(p.social!).facebook).toBe("https://www.facebook.com/acmepromotions");
    // hero+description+socials+contact covered, but logo is still empty (the
    // og:image was a wide hero, not a square logo) → recompute keeps
    // NEEDS_ENRICHMENT. last_enriched_at is stamped since fills were written.
    expect(p.status).toBe("NEEDS_ENRICHMENT");
    expect(p.last).not.toBeNull();
    // The applied candidates are marked auto_merged.
    const merged = await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.promoterId, id));
    expect(merged.every((c) => c.decision === "auto_merged")).toBe(true);
  });

  it("logo-shaped og:image is staged but NEVER auto-applied (even on a live run)", async () => {
    const { db } = createTestDb();
    const id = await insertPromoter(db, {
      companyName: "Squareish Co",
      website: "https://squareish.com",
    });
    // A square, logo-token'd og:image → classified logo → autoApply=false.
    const html = `<meta property="og:image" content="https://cdn.squareish.com/site-logo.png">`;
    restore = mockSite(html, { "site-logo.png": makePng(800, 800) });

    await processPromoterEnrichmentJob(db, ENV, {
      promoterId: id,
      jobRunId: "j-logo",
      dryRun: false,
    });

    const [p] = await db
      .select({ logo: promoters.logoUrl })
      .from(promoters)
      .where(eq(promoters.id, id));
    expect(p.logo).toBeNull(); // not auto-applied
    const staged = await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.promoterId, id));
    const logo = staged.find((c) => c.proposedField === "logo");
    expect(logo).toBeTruthy();
    expect(logo!.decision).toBe("pending"); // stays for manual review
  });

  it("fill-empty-only: a populated field is never proposed", async () => {
    const { db } = createTestDb();
    const id = await insertPromoter(db, {
      companyName: "Half Filled",
      website: "https://halffilled.com",
      contactEmail: "existing@halffilled.com",
    });
    const html = jsonLd({
      "@type": "Organization",
      telephone: "(207) 555-2222",
      email: "scraped@halffilled.com",
    });
    restore = mockSite(html);

    await processPromoterEnrichmentJob(db, ENV, {
      promoterId: id,
      jobRunId: "j-fill",
      dryRun: true,
    });

    const staged = await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.promoterId, id));
    expect(staged.some((c) => c.proposedField === "contact_email")).toBe(false); // already set
    expect(staged.some((c) => c.proposedField === "contact_phone")).toBe(true); // was empty
  });
});
