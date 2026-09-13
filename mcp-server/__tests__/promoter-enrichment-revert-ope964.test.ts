/**
 * OPE-964 — an auto_merged promoter enrichment value can be undone, the undo
 * sticks, and it is counted against the rule that applied it.
 *
 * Driven end to end through the real dispatcher: a live render auto-applies a
 * phone number, the review tool reverts it, and a second render must NOT put it
 * back — the failure mode a revert without suppression would have (fill-empty-
 * only sees an empty field and refills it).
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
import { computeRuleAgreement } from "../../src/lib/promoter-enrichment-dashboard.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://meetmeatthefair.com",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;
const ADMIN = { userId: "u-admin", role: "ADMIN" as const };

const HAS_PHONE = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Organization",
  telephone: "(207) 555-0100",
})}</script>`;

let db: TestDb;
let server: CapturingMcpServer;
let indexNow: ReturnType<typeof mockIndexNowFetch>;
let restoreFetch: (() => void) | null = null;

function serve(html: string) {
  restoreFetch?.();
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("barren.example.com")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    return orig(input, init);
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = orig);
}

beforeEach(async () => {
  ({ db } = createTestDb());
  indexNow = mockIndexNowFetch();
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN, ENV as never);
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Weston Craft Show",
    slug: "weston-craft-show",
    website: "https://barren.example.com",
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
  serve(HAS_PHONE);
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  indexNow.restore();
});

const render = (dryRun = false) =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: "p1", jobRunId: `j-${Date.now()}`, dryRun });
const promoter = async () => (await db.select().from(promoters).where(eq(promoters.id, "p1")))[0];
const candidates = async () =>
  db
    .select()
    .from(promoterEnrichmentCandidates)
    .where(eq(promoterEnrichmentCandidates.proposedField, "contact_phone"));
async function tool(name: string, args: Record<string, unknown>) {
  const r = (await server.invoke(name, args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(r.content[0].text);
  } catch {
    body = { text: r.content[0].text };
  }
  return { ...body, isError: r.isError === true };
}

async function autoMergedPhone() {
  await render();
  const [c] = await candidates();
  expect(c.decision).toBe("auto_merged"); // landmark: the pipeline really auto-applied
  expect((await promoter()).contactPhone).toBe(c.proposedValue);
  return c;
}

describe("OPE-964 — revert an auto_merged candidate", () => {
  it("ACCEPTANCE: restores the pre-merge value, recomputes coverage, marks 'reverted'", async () => {
    const c = await autoMergedPhone();
    const coverageBefore = (await promoter()).enrichmentCoverage;

    const res = await tool("review_promoter_enrichment_candidate", {
      candidate_id: c.id,
      action: "revert",
    });
    expect(res).toMatchObject({ success: true, decision: "reverted", restored_value: null });

    const p = await promoter();
    expect(p.contactPhone).toBeNull();
    expect(p.enrichmentCoverage).not.toBe(coverageBefore); // recomputed, not left stale
    expect(JSON.parse(p.enrichmentCoverage ?? "{}")).toMatchObject({ contact: false });
    expect((await candidates())[0].decision).toBe("reverted");
  });

  it("ACCEPTANCE: the next render does NOT re-apply the reverted value — it stages it, flagged", async () => {
    const c = await autoMergedPhone();
    await tool("review_promoter_enrichment_candidate", { candidate_id: c.id, action: "revert" });

    await render(); // a LIVE run, where auto-apply is on
    expect((await promoter()).contactPhone).toBeNull();
    const rows = await candidates();
    const pending = rows.find((r) => r.decision === "pending");
    expect(pending?.proposedValue).toBe(c.proposedValue);
    expect(JSON.parse(pending!.flags)).toContain("previously_reverted");
  });

  it("ACCEPTANCE: refuses when the field was edited after the merge, and changes nothing", async () => {
    const c = await autoMergedPhone();
    await db.update(promoters).set({ contactPhone: "207-555-9999" }).where(eq(promoters.id, "p1"));

    const res = await tool("review_promoter_enrichment_candidate", {
      candidate_id: c.id,
      action: "revert",
    });
    expect(res).toMatchObject({
      isError: true,
      error: "field_changed_since_merge",
      current_value: "207-555-9999",
    });
    expect((await promoter()).contactPhone).toBe("207-555-9999");
    expect((await candidates())[0].decision).toBe("auto_merged");
  });

  it("only an auto_merged candidate is revertible", async () => {
    await render(true); // dry run → pending
    const [pending] = await candidates();
    expect(pending.decision).toBe("pending");
    expect(
      await tool("review_promoter_enrichment_candidate", {
        candidate_id: pending.id,
        action: "revert",
      })
    ).toMatchObject({ isError: true, error: "not_revertible", decision: "pending" });
  });

  it("restores the value the field held when staged (captured from now on), not always NULL", async () => {
    await db.update(promoters).set({ contactPhone: "" }).where(eq(promoters.id, "p1"));
    const c = await autoMergedPhone();
    expect(c.currentValue).toBe(""); // captured at staging
    await tool("review_promoter_enrichment_candidate", { candidate_id: c.id, action: "revert" });
    expect((await promoter()).contactPhone).toBe("");
  });
});

describe("OPE-964 — a revert counts against the rule", () => {
  it("ACCEPTANCE: one reverted row moves humanAgreementPct DOWN, not sideways", () => {
    const rows = Array.from({ length: 20 }, () => ({
      decision: "approved",
      proposedField: "social_links",
      extractionMethod: "social-link",
    }));
    const [before] = computeRuleAgreement(rows);
    expect(before).toMatchObject({ humanAgreementPct: 100, promotable: true });
    const [after] = computeRuleAgreement([
      ...rows,
      { decision: "reverted", proposedField: "social_links", extractionMethod: "social-link" },
    ]);
    expect(after.humanAgreementPct).toBeLessThan(before.humanAgreementPct);
    expect(after).toMatchObject({ humanReverted: 1, humanRejected: 1, humanSampleSize: 21 });
  });
});

describe("OPE-964 — update_promoter clear_fields", () => {
  beforeEach(async () => {
    await db
      .update(promoters)
      .set({ contactPhone: "207-555-0100", logoUrl: "https://cdn.x/logo.png" })
      .where(eq(promoters.id, "p1"));
  });

  it("ACCEPTANCE: sets the fields to NULL (not '') and recomputes coverage from the cleared value", async () => {
    const res = await tool("update_promoter", {
      promoter_id: "p1",
      clear_fields: ["contact_phone", "logo_url"],
    });
    expect(res.isError).toBe(false);
    const p = await promoter();
    expect(p.contactPhone).toBeNull();
    expect(p.logoUrl).toBeNull();
    // With `??` the recompute would have read the OLD phone back and called
    // contact covered.
    expect(JSON.parse(p.enrichmentCoverage ?? "{}")).toMatchObject({ contact: false, logo: false });
  });

  it("refuses a field that is both set and cleared", async () => {
    const res = await tool("update_promoter", {
      promoter_id: "p1",
      contact_phone: "207-555-1111",
      clear_fields: ["contact_phone"],
    });
    expect(res.isError).toBe(true);
    expect((await promoter()).contactPhone).toBe("207-555-0100");
  });
});
