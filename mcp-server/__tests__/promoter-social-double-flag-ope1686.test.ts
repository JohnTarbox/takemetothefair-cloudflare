/**
 * OPE-1686 — a social payload the pipeline has TWO reasons to distrust (no name
 * affinity AND a prior human veto) is dropped, not re-staged; either reason
 * alone still stages. Plus: WordPress theme-vendor accounts (AncoraThemes, the
 * SoWa Boston specimen) are platform placeholders and never become a proposal.
 *
 * Driven through the real dispatcher on dry runs, so nothing auto-applies and
 * what we read back is exactly what was staged.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";
import {
  dropVetoedUnaffineSocials,
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import { isPlatformPlaceholderHandle } from "../src/enrichment/extract.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://meetmeatthefair.com",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

const footer = (handle: string) =>
  `<html><body><footer>
     <a href="https://www.facebook.com/${handle}/">Facebook</a>
     <a href="https://www.instagram.com/${handle}/">Instagram</a>
   </footer></body></html>`;

let db: TestDb;
let indexNow: ReturnType<typeof mockIndexNowFetch>;
let restoreFetch: (() => void) | null = null;

function serve(html: string) {
  restoreFetch?.();
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("sowa.example.com")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    return orig(input, init);
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = orig);
}

beforeEach(async () => {
  ({ db } = createTestDb());
  indexNow = mockIndexNowFetch();
  await db.insert(promoters).values({
    id: "p1",
    companyName: "SoWa Boston",
    slug: "sowa-boston",
    website: "https://sowa.example.com",
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  indexNow.restore();
});

const dryRender = () =>
  processPromoterEnrichmentJob(db, ENV, {
    promoterId: "p1",
    jobRunId: `j-${Math.random()}`,
    dryRun: true,
  });
const socialRows = async () =>
  db
    .select()
    .from(promoterEnrichmentCandidates)
    .where(eq(promoterEnrichmentCandidates.proposedField, "social_links"));
const pendingSocial = async () =>
  (
    await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(
        and(
          eq(promoterEnrichmentCandidates.proposedField, "social_links"),
          eq(promoterEnrichmentCandidates.decision, "pending")
        )
      )
  )[0];
async function veto(decision: "rejected" | "reverted") {
  const row = await pendingSocial();
  await db
    .update(promoterEnrichmentCandidates)
    .set({ decision })
    .where(eq(promoterEnrichmentCandidates.id, row.id));
  return row;
}

describe("OPE-1686 — the double-flag social drop", () => {
  it("ACCEPTANCE: an unaffine payload a human REJECTED is not re-staged", async () => {
    serve(footer("UnrelatedThemeCo"));
    await dryRender();
    // Landmark: the single-flag case really stages, so the drop below is not
    // an extractor that found nothing.
    const first = await pendingSocial();
    expect(first).toBeDefined();
    expect(JSON.parse(first.flags)).toEqual(["social_no_name_affinity"]);

    await veto("rejected");
    await dryRender();
    expect(await pendingSocial()).toBeUndefined();
    // The human verdict row is untouched; nothing new was written for the value.
    const rows = await socialRows();
    expect(rows.map((r) => r.decision)).toEqual(["rejected"]);
  });

  it("ACCEPTANCE: the same holds for a REVERT", async () => {
    serve(footer("UnrelatedThemeCo"));
    await dryRender();
    await veto("reverted");
    await dryRender();
    expect(await pendingSocial()).toBeUndefined();
  });

  it("NARROW: an affine payload a human rejected still stages, flagged (veto alone)", async () => {
    serve(footer("sowaboston"));
    await dryRender();
    const first = await pendingSocial();
    expect(JSON.parse(first.flags)).toEqual([]); // affine
    await veto("rejected");
    await dryRender();
    const again = await pendingSocial();
    expect(again?.proposedValue).toBe(first.proposedValue);
    expect(JSON.parse(again!.flags)).toEqual(["previously_rejected"]);
  });

  it("NARROW: an unaffine payload with a DIFFERENT value than the vetoed one still stages", async () => {
    serve(footer("UnrelatedThemeCo"));
    await dryRender();
    await veto("rejected");
    serve(footer("SomeOtherCo"));
    await dryRender();
    const again = await pendingSocial();
    expect(again).toBeDefined();
    expect(JSON.parse(again!.flags)).toEqual(["social_no_name_affinity"]);
  });
});

describe("OPE-1686 — theme-vendor accounts are platform placeholders", () => {
  it("ACCEPTANCE: AncoraThemes' footer accounts never become a social proposal", async () => {
    serve(footer("ancora_themes"));
    await dryRender();
    expect(await socialRows()).toHaveLength(0);
  });

  it("matches whole handles only", () => {
    expect(isPlatformPlaceholderHandle("https://twitter.com/ancora_themes")).toBe(true);
    expect(isPlatformPlaceholderHandle("https://www.facebook.com/AncoraThemes/")).toBe(true);
    expect(isPlatformPlaceholderHandle("https://www.facebook.com/elementor")).toBe(true);
    expect(isPlatformPlaceholderHandle("https://www.facebook.com/ancorabakery")).toBe(false);
  });
});

describe("dropVetoedUnaffineSocials (unit)", () => {
  it("drops only social_links carrying BOTH flags", () => {
    const ps = [
      { field: "social_links", flags: ["social_no_name_affinity", "previously_rejected"] },
      { field: "social_links", flags: ["social_no_name_affinity"] },
      { field: "social_links", flags: ["previously_reverted"] },
      { field: "contact_email", flags: ["social_no_name_affinity", "previously_rejected"] },
    ];
    expect(dropVetoedUnaffineSocials(ps)).toBe(1);
    expect(ps.map((p) => p.flags)).toEqual([
      ["social_no_name_affinity"],
      ["previously_reverted"],
      ["social_no_name_affinity", "previously_rejected"],
    ]);
  });
});
