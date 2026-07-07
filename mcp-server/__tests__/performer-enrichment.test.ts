/**
 * OPE-116 performer pre-extraction — extraction + dispatcher suite (the
 * performer analog of promoter-enrichment.test.ts).
 *
 *   - extractPerformerSignals: contact / social / description / og:image mapping
 *   - processPerformerEnrichmentJob: candidate staging, auto-apply gating
 *     (image NEVER auto-applies), BLOCKED on fetch fail, NO_SOURCE on no website,
 *     fill-empty-only.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { performers, performerEnrichmentCandidates, enrichmentLog } from "../src/schema.js";
import { extractPerformerSignals } from "../src/enrichment/performer-extract.js";
import {
  processPerformerEnrichmentJob,
  type PerformerEnrichmentEnv,
} from "../src/enrichment/performer-dispatch.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as PerformerEnrichmentEnv;

const jsonLd = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

/** Minimal PNG whose header encodes the given dimensions. */
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

async function insertPerformer(db: TestDb, over: Record<string, unknown>): Promise<string> {
  const id = (over.id as string) ?? `perf-${Math.floor(Math.random() * 1e9)}`;
  await db.insert(performers).values({
    id,
    name: (over.name as string) ?? "Test Act",
    slug: (over.slug as string) ?? `slug-${id}`,
    ...over,
  } as never);
  return id;
}

// ---------------------------------------------------------------------------
// extractPerformerSignals (pure)
// ---------------------------------------------------------------------------
describe("extractPerformerSignals — signal mapping", () => {
  it("maps og:image, contact, social, and description", () => {
    const html =
      `<head><meta property="og:image" content="https://cdn.drew.com/drew.png">` +
      `<meta name="description" content="Mr. Drew brings live animals to fairs across New England."></head>` +
      jsonLd({
        "@type": "Person",
        telephone: "(207) 555-0100",
        email: "hello@misterdrew.com",
        sameAs: ["https://www.facebook.com/misterdrew"],
      });
    const ex = extractPerformerSignals(html, "https://misterdrew.com");
    expect(ex.ogImage).toBe("https://cdn.drew.com/drew.png");
    expect(ex.contactPhone?.value).toBe("(207) 555-0100");
    expect(ex.contactEmail?.value).toBe("hello@misterdrew.com");
    expect(ex.description?.value).toContain("Mr. Drew");
    const social = JSON.parse(ex.socialLinks!.value) as Record<string, string>;
    expect(social.facebook).toBe("https://www.facebook.com/misterdrew");
  });

  it("resolves a relative og:image against the source URL", () => {
    const html = `<meta property="og:image" content="/img/photo.png">`;
    const ex = extractPerformerSignals(html, "https://misterdrew.com/about");
    expect(ex.ogImage).toBe("https://misterdrew.com/img/photo.png");
  });

  it("falls back to twitter:image when og:image is absent", () => {
    const html = `<meta name="twitter:image" content="https://cdn.drew.com/tw.png">`;
    const ex = extractPerformerSignals(html, "https://misterdrew.com");
    expect(ex.ogImage).toBe("https://cdn.drew.com/tw.png");
  });
});

// ---------------------------------------------------------------------------
// processPerformerEnrichmentJob (real D1, mocked fetch)
// ---------------------------------------------------------------------------
describe("processPerformerEnrichmentJob", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("NO_SOURCE when the performer has no website (stamps attempt, stages nothing)", async () => {
    const { db } = createTestDb();
    const id = await insertPerformer(db, { name: "No Site", website: null });

    const summary = await processPerformerEnrichmentJob(db, ENV, {
      performerId: id,
      jobRunId: "j-nosite",
      dryRun: true,
    });

    expect(summary.outcome).toBe("no_source");
    const [p] = await db
      .select({ s: performers.enrichmentStatus, a: performers.enrichmentAttemptedAt })
      .from(performers)
      .where(eq(performers.id, id));
    expect(p.s).toBe("NO_SOURCE");
    expect(p.a).not.toBeNull();
    const staged = await db
      .select()
      .from(performerEnrichmentCandidates)
      .where(eq(performerEnrichmentCandidates.performerId, id));
    expect(staged).toHaveLength(0);
  });

  it("BLOCKED (host_gated) when the website host is SSRF-blocked", async () => {
    const { db } = createTestDb();
    const id = await insertPerformer(db, { name: "Local Only", website: "https://localhost/" });

    const summary = await processPerformerEnrichmentJob(db, ENV, {
      performerId: id,
      jobRunId: "j-blocked",
      dryRun: true,
    });

    expect(summary.outcome).toBe("blocked");
    expect(summary.blockedReason).toBe("host_gated");
    const [p] = await db
      .select({ s: performers.enrichmentStatus, r: performers.enrichmentBlockedReason })
      .from(performers)
      .where(eq(performers.id, id));
    expect(p.s).toBe("BLOCKED");
    expect(p.r).toBe("host_gated");
    const logs = await db.select().from(enrichmentLog).where(eq(enrichmentLog.targetId, id));
    expect(logs.some((l) => l.status === "failure")).toBe(true);
  });

  it("dry-run stages candidates WITHOUT touching the live performer row", async () => {
    const { db } = createTestDb();
    const id = await insertPerformer(db, {
      name: "Mr. Drew",
      website: "https://misterdrew.com",
    });
    const html =
      `<meta property="og:image" content="https://cdn.drew.com/drew.png">` +
      `<meta name="description" content="Mr. Drew brings live animals to fairs across New England.">` +
      jsonLd({
        "@type": "Person",
        telephone: "(207) 555-0100",
        email: "hello@misterdrew.com",
        sameAs: ["https://www.facebook.com/misterdrew"],
      });
    restore = mockSite(html, { "drew.png": makePng(1200, 600) });

    const summary = await processPerformerEnrichmentJob(db, ENV, {
      performerId: id,
      jobRunId: "j-dry",
      dryRun: true,
    });

    expect(summary.outcome).toBe("staged");
    const staged = await db
      .select()
      .from(performerEnrichmentCandidates)
      .where(eq(performerEnrichmentCandidates.performerId, id));
    const fields = staged.map((s) => s.proposedField).sort();
    expect(fields).toEqual([
      "contact_email",
      "contact_phone",
      "description",
      "image",
      "social_links",
    ]);
    expect(staged.every((s) => s.decision === "pending")).toBe(true);
    // Live row untouched.
    const [p] = await db
      .select({ image: performers.imageUrl, email: performers.contactEmail })
      .from(performers)
      .where(eq(performers.id, id));
    expect(p.image).toBeNull();
    expect(p.email).toBeNull();
  });

  it("live run auto-applies contact/social/description but NEVER the image", async () => {
    const { db } = createTestDb();
    const id = await insertPerformer(db, {
      name: "Mr. Drew",
      website: "https://misterdrew.com",
    });
    const html =
      `<meta property="og:image" content="https://cdn.drew.com/drew.png">` +
      `<meta name="description" content="Mr. Drew brings live animals to fairs across New England.">` +
      jsonLd({
        "@type": "Person",
        telephone: "(207) 555-0100",
        email: "hello@misterdrew.com",
        sameAs: ["https://www.facebook.com/misterdrew"],
      });
    restore = mockSite(html, { "drew.png": makePng(1200, 600) });

    const summary = await processPerformerEnrichmentJob(db, ENV, {
      performerId: id,
      jobRunId: "j-live",
      dryRun: false,
    });

    expect(summary.outcome).toBe("merged");
    expect((summary.appliedFields ?? []).sort()).toEqual([
      "contact_email",
      "contact_phone",
      "description",
      "social_links",
    ]);
    const [p] = await db
      .select({
        image: performers.imageUrl,
        email: performers.contactEmail,
        phone: performers.contactPhone,
        social: performers.socialLinks,
        desc: performers.description,
        status: performers.enrichmentStatus,
        last: performers.lastEnrichedAt,
      })
      .from(performers)
      .where(eq(performers.id, id));
    // Image is staged for review, never auto-applied.
    expect(p.image).toBeNull();
    expect(p.email).toBe("hello@misterdrew.com");
    expect(p.phone).toBe("(207) 555-0100");
    expect(p.desc).toContain("Mr. Drew");
    expect(JSON.parse(p.social!).facebook).toBe("https://www.facebook.com/misterdrew");
    // description+socials+contact covered, but image still empty → NEEDS_ENRICHMENT.
    expect(p.status).toBe("NEEDS_ENRICHMENT");
    expect(p.last).not.toBeNull();
    // The image candidate stays pending; the rest are auto_merged.
    const staged = await db
      .select()
      .from(performerEnrichmentCandidates)
      .where(eq(performerEnrichmentCandidates.performerId, id));
    const image = staged.find((c) => c.proposedField === "image");
    expect(image!.decision).toBe("pending");
    expect(
      staged.filter((c) => c.proposedField !== "image").every((c) => c.decision === "auto_merged")
    ).toBe(true);
  });

  it("fill-empty-only: a populated field is never proposed", async () => {
    const { db } = createTestDb();
    const id = await insertPerformer(db, {
      name: "Half Filled",
      website: "https://halffilled.com",
      contactEmail: "existing@halffilled.com",
    });
    const html = jsonLd({
      "@type": "Person",
      telephone: "(207) 555-2222",
      email: "scraped@halffilled.com",
    });
    restore = mockSite(html);

    await processPerformerEnrichmentJob(db, ENV, {
      performerId: id,
      jobRunId: "j-fill",
      dryRun: true,
    });

    const staged = await db
      .select()
      .from(performerEnrichmentCandidates)
      .where(eq(performerEnrichmentCandidates.performerId, id));
    expect(staged.some((c) => c.proposedField === "contact_email")).toBe(false); // already set
    expect(staged.some((c) => c.proposedField === "contact_phone")).toBe(true); // was empty
  });
});
