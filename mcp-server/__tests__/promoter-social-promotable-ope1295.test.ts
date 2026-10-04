/**
 * OPE-1295 — an affine social payload auto-applies only when the social_links
 * rule is `promotable` (≥95% over ≥20 clean human decisions, the figure
 * get_promoter_enrichment_rule_agreement reports). John, 2026-10-04, after 70
 * affinity-only auto-applies since 09-23 drew ~70% human agreement.
 *
 * Driven through the real live dispatcher.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { promoters, promoterEnrichmentCandidates } from "../src/schema.js";
import {
  processPromoterEnrichmentJob,
  socialRulePromotable,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

// Affine (handle carries the promoter's name), so only the new gate can hold it.
const HTML = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Organization",
  telephone: "(207) 555-0100",
  sameAs: ["https://www.facebook.com/acmepromotions"],
})}</script>`;

let db: TestDb;
let restore: () => void;

beforeEach(async () => {
  ({ db } = createTestDb());
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  restore = () => (globalThis.fetch = orig);
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Acme Promotions",
    slug: "acme-promotions",
    website: "https://acmepromotions.com",
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
});
afterEach(() => restore());

async function seed(
  approved: number,
  rejected: number,
  opts: { flags?: string; reviewedBy?: string } = {}
) {
  const decisions = [
    ...Array.from({ length: approved }, () => "approved"),
    ...Array.from({ length: rejected }, () => "rejected"),
  ];
  for (const [i, decision] of decisions.entries()) {
    await db.insert(promoterEnrichmentCandidates).values({
      promoterId: `hist-${i}`,
      jobRunId: "hist",
      proposedField: "social_links",
      proposedValue: "{}",
      sourceUrl: "https://hist.example.com",
      extractionMethod: "jsonld",
      createdAt: new Date(),
      reviewedBy: opts.reviewedBy ?? "u-admin",
      flags: opts.flags ?? "[]",
      decision,
    } as never);
  }
}

const live = () =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: "p1", jobRunId: "j-live", dryRun: false });
const promoter = async () => (await db.select().from(promoters).where(eq(promoters.id, "p1")))[0];
const socialCandidate = async () =>
  (
    await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(
        and(
          eq(promoterEnrichmentCandidates.promoterId, "p1"),
          eq(promoterEnrichmentCandidates.proposedField, "social_links")
        )
      )
  )[0];

describe("OPE-1295 — a non-promotable rule holds the affine social payload", () => {
  it("with NO review history: social is staged pending, not applied — and the phone still applies", async () => {
    const r = await live();
    expect(r.outcome).toBe("merged");
    expect(r.socialStagedNotPromotable).toBe(1);
    const p = await promoter();
    expect(p.socialLinks ?? null).toBeNull();
    expect(p.contactPhone).toBe("(207) 555-0100"); // other fields are untouched by the gate
    expect((await socialCandidate()).decision).toBe("pending");
  });

  it("at 19 clean approvals (one short of the sample floor) it still holds", async () => {
    await seed(19, 0);
    expect((await live()).socialStagedNotPromotable).toBe(1);
    expect((await promoter()).socialLinks ?? null).toBeNull();
  });

  it("at 20 approvals + 2 rejections (90.9%, under 95%) it holds", async () => {
    await seed(20, 2);
    expect((await live()).socialStagedNotPromotable).toBe(1);
  });

  it("FLAGGED or system-closed history does not count toward promotion", async () => {
    await seed(20, 0, { flags: '["social_no_name_affinity"]' });
    await seed(20, 0, { reviewedBy: "system:promoter-merge" });
    expect(await socialRulePromotable(db, "jsonld")).toBe(false);
  });
});

describe("OPE-1295 — a promotable rule applies it, as before", () => {
  it("at 20 clean human approvals the affine payload auto-applies", async () => {
    await seed(20, 0);
    const r = await live();
    expect(r.socialStagedNotPromotable).toBe(0);
    expect(JSON.parse((await promoter()).socialLinks!).facebook).toBe(
      "https://www.facebook.com/acmepromotions"
    );
    expect((await socialCandidate()).decision).toBe("auto_merged");
  });

  it("promotion is per extraction METHOD: a promotable regex rule does not open jsonld", async () => {
    for (let i = 0; i < 20; i++) {
      await db.insert(promoterEnrichmentCandidates).values({
        promoterId: `rx-${i}`,
        jobRunId: "hist",
        proposedField: "social_links",
        proposedValue: "{}",
        sourceUrl: "https://hist.example.com",
        extractionMethod: "regex",
        createdAt: new Date(),
        reviewedBy: "u-admin",
        decision: "approved",
      } as never);
    }
    expect(await socialRulePromotable(db, "regex")).toBe(true);
    expect(await socialRulePromotable(db, "jsonld")).toBe(false);
  });
});
