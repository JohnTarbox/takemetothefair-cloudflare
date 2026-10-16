/**
 * OPE-1393 (CLB6) — an enrichment auto-fill never overwrites a value an
 * operator wrote while the job was fetching the site.
 *
 * Every dispatcher reads the row, fetches the entity's site (seconds, sometimes
 * a Browser-Rendering escalation), then writes its "fill-empty-only" values.
 * The write used to be `WHERE id = ?` alone, so emptiness was judged from the
 * stale pre-fetch read. The race is reproduced here by writing the operator's
 * value INSIDE the stubbed fetch — i.e. after the read, before the write.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  vendors,
  vendorEnrichmentCandidates,
  promoters,
  promoterEnrichmentCandidates,
  performers,
  performerEnrichmentCandidates,
} from "../src/schema.js";
import { processEnrichmentJob } from "../src/enrichment/dispatch.js";
import { processPromoterEnrichmentJob } from "../src/enrichment/promoter-dispatch.js";
import { processPerformerEnrichmentJob } from "../src/enrichment/performer-dispatch.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "t",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as never;

const OPERATOR_PHONE = "(207) 111-2222";

function page(type: string) {
  return `<script type="application/ld+json">${JSON.stringify({
    "@type": type,
    telephone: "(207) 265-4318",
    email: "team@mergeco.com",
    address: { addressLocality: "Bangor", addressRegion: "ME" },
  })}</script>`;
}

let restore: (() => void) | null = null;
/** Serve `html` for the entity's site, running `duringFetch` first (the race). */
function serveWithRace(host: string, html: string, duringFetch: () => void) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(host)) {
      duringFetch();
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.includes("indexnow") || url.includes("bing")) return new Response("", { status: 200 });
    return orig(input, init);
  }) as typeof fetch;
  restore = () => (globalThis.fetch = orig);
}
afterEach(() => {
  restore?.();
  restore = null;
});

describe("OPE-1393 CLB6 — vendor auto-merge", () => {
  it("an operator phone written during the fetch survives; the untouched email still fills", async () => {
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
    serveWithRace("mergeco.com", page("LocalBusiness"), () => {
      db.update(vendors).set({ contactPhone: OPERATOR_PHONE }).where(eq(vendors.id, "v1")).run();
    });

    const summary = await processEnrichmentJob(db, ENV, {
      vendorId: "v1",
      jobRunId: "j-live",
      dryRun: false,
    });

    const [v] = await db.select().from(vendors).where(eq(vendors.id, "v1"));
    expect(v.contactPhone).toBe(OPERATOR_PHONE);
    expect(v.contactEmail).toBe("team@mergeco.com"); // control: the lane still merges
    expect(summary.appliedFields).toEqual(["contact_email"]);
    const phone = (await db.select().from(vendorEnrichmentCandidates)).find(
      (r) => r.proposedField === "contact_phone"
    );
    expect(phone?.decision).toBe("pending"); // not marked auto_merged
  });
});

describe("OPE-1393 CLB6 — promoter auto-apply", () => {
  it("an operator phone written during the fetch survives", async () => {
    const { db } = createTestDb();
    await db.insert(promoters).values({
      id: "p1",
      companyName: "Merge Co",
      slug: "merge-co",
      website: "https://mergeco.com",
      enrichmentStatus: "NEEDS_ENRICHMENT",
    } as never);
    serveWithRace("mergeco.com", page("Organization"), () => {
      db.update(promoters)
        .set({ contactPhone: OPERATOR_PHONE })
        .where(eq(promoters.id, "p1"))
        .run();
    });

    const summary = await processPromoterEnrichmentJob(db, ENV, {
      promoterId: "p1",
      jobRunId: "j-live",
      dryRun: false,
    });

    const [p] = await db.select().from(promoters).where(eq(promoters.id, "p1"));
    expect(p.contactPhone).toBe(OPERATOR_PHONE);
    expect(p.contactEmail).toBe("team@mergeco.com"); // control
    expect(summary.appliedFields).not.toContain("contact_phone");
    const phone = (await db.select().from(promoterEnrichmentCandidates)).find(
      (r) => r.proposedField === "contact_phone"
    );
    expect(phone?.decision).not.toBe("auto_merged");
  });
});

describe("OPE-1393 CLB6 — performer auto-apply", () => {
  it("an operator phone written during the fetch survives", async () => {
    const { db } = createTestDb();
    await db.insert(performers).values({
      id: "pf1",
      name: "Merge Co Band",
      slug: "merge-co-band",
      website: "https://mergeco.com",
    } as never);
    serveWithRace("mergeco.com", page("MusicGroup"), () => {
      (db as TestDb)
        .update(performers)
        .set({ contactPhone: OPERATOR_PHONE })
        .where(eq(performers.id, "pf1"))
        .run();
    });

    const summary = await processPerformerEnrichmentJob(db, ENV, {
      performerId: "pf1",
      jobRunId: "j-live",
      dryRun: false,
    });

    const [p] = await db.select().from(performers).where(eq(performers.id, "pf1"));
    expect(p.contactPhone).toBe(OPERATOR_PHONE);
    expect(p.contactEmail).toBe("team@mergeco.com"); // control
    expect((summary as { appliedFields?: string[] }).appliedFields ?? []).not.toContain(
      "contact_phone"
    );
    const phone = (await db.select().from(performerEnrichmentCandidates)).find(
      (r) => r.proposedField === "contact_phone"
    );
    expect(phone?.decision).not.toBe("auto_merged");
  });
});
