/**
 * OPE-1712 — the nightly promoter-enrichment cron auto-applies the same fills a
 * live enrich_promoter(dry_run=false) call does.
 *
 * Before: the selector read the shared ENRICHMENT_DRY_RUN ("true" in prod, and
 * it must stay "true" for the vendor + performer crons), so every cron message
 * carried dryRun=true and the cron had auto-merged 0 candidates, ever.
 *
 * The route under test is the cron's real one: the committed wrangler [vars]
 * → runScheduledPromoterEnrichment → the queue message it builds →
 * handlePromoterEnrichmentBatch → processPromoterEnrichmentJob. No gate is
 * re-implemented for the cron, so the OPE-1706 / OPE-1707 gates apply as-is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";

const holder: { db: TestDb | null } = { db: null };
vi.mock("../src/db.js", () => ({ getDb: () => holder.db }));

const { runScheduledPromoterEnrichment, promoterCronDryRun } =
  await import("../src/enrichment/promoter-select.js");
const { handlePromoterEnrichmentBatch } = await import("../src/enrichment/promoter-dispatch.js");

/** The [vars] values as committed — what `wrangler deploy` ships. */
function committedVar(name: string): string | undefined {
  const toml = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");
  const m = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
  return m?.[1];
}

describe("OPE-1712 — promoterCronDryRun", () => {
  it("the committed config: vendors stay dry-run, the promoter cron is live", () => {
    expect(committedVar("ENRICHMENT_DRY_RUN")).toBe("true");
    expect(committedVar("PROMOTER_ENRICHMENT_DRY_RUN")).toBe("false");
    expect(
      promoterCronDryRun({
        DB: {} as D1Database,
        ENRICHMENT_DRY_RUN: committedVar("ENRICHMENT_DRY_RUN"),
        PROMOTER_ENRICHMENT_DRY_RUN: committedVar("PROMOTER_ENRICHMENT_DRY_RUN"),
      })
    ).toBe(false);
  });

  it.each([
    [undefined, undefined, true],
    [undefined, "true", true],
    [undefined, "false", false], // unset falls back to the shared flag
    ["true", "false", true], // the promoter switch wins when set
    ["false", "true", false],
    ["FALSE", "true", true], // only the exact string "false" is live
  ])("PROMOTER=%s ENRICHMENT=%s → dryRun %s", (p, e, want) => {
    expect(
      promoterCronDryRun({
        DB: {} as D1Database,
        PROMOTER_ENRICHMENT_DRY_RUN: p,
        ENRICHMENT_DRY_RUN: e,
      })
    ).toBe(want);
  });
});

describe("OPE-1712 — cron → queue → dispatcher, end to end", () => {
  let db: TestDb;
  let indexNow: ReturnType<typeof mockIndexNowFetch>;
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    ({ db } = createTestDb());
    holder.db = db;
    indexNow = mockIndexNowFetch();
  });
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    indexNow.restore();
  });

  function serve(pages: Record<string, string>) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const hit = Object.keys(pages).find((k) => url === k || url === `${k}/`);
      if (hit) {
        return new Response(pages[hit], { status: 200, headers: { "content-type": "text/html" } });
      }
      if (/\.example\b/.test(url)) return new Response("nope", { status: 404 });
      return orig(input, init);
    }) as typeof fetch;
    restoreFetch = () => (globalThis.fetch = orig);
  }

  /** Run the selector, then feed every message it enqueued to the real consumer. */
  async function runCron(env: {
    ENRICHMENT_DRY_RUN?: string;
    PROMOTER_ENRICHMENT_DRY_RUN?: string;
  }) {
    const bodies: Array<{ promoterId: string; jobRunId: string; dryRun: boolean }> = [];
    const queue = {
      sendBatch: async (msgs: Array<{ body: (typeof bodies)[number] }>) => {
        bodies.push(...msgs.map((m) => m.body));
      },
    };
    const jobRunId = "promoter-cron-2026-11-27-abcd1234";
    await runScheduledPromoterEnrichment(
      { DB: {} as D1Database, PROMOTER_ENRICHMENT: queue as never, ...env },
      jobRunId,
      Date.now()
    );
    await handlePromoterEnrichmentBatch(
      {
        queue: "promoter-enrichment",
        messages: bodies.map((body) => ({ body, ack: () => {}, retry: () => {} })),
      },
      {
        DB: {} as D1Database,
        CLOUDFLARE_ACCOUNT_ID: "test",
        MAIN_APP_URL: "https://meetmeatthefair.com",
        INTERNAL_API_KEY: "k",
      } as never
    );
    return { bodies, jobRunId };
  }

  async function seedMaineFair() {
    await db.insert(promoters).values({
      id: "fair",
      companyName: "Pine Hill Fair",
      slug: "pine-hill-fair",
      website: "https://pinehillfair.example/",
      state: "ME",
      enrichmentStatus: "NEEDS_ENRICHMENT",
    } as never);
    serve({
      "https://pinehillfair.example": `<html><head>
        <meta property="og:image" content="https://pinehillfair.example/logo.png">
        </head><body>
        <a href="mailto:hello@pinehillfair.example">Email us</a>
        <a href="tel:+16055550142">Call</a>
        </body></html>`,
    });
  }

  const cands = () =>
    db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(eq(promoterEnrichmentCandidates.promoterId, "fair"));

  it("ACCEPTANCE: with the committed flags the cron auto-merges the mailto, stages the flagged phone and the logo", async () => {
    await seedMaineFair();
    const { bodies, jobRunId } = await runCron({
      ENRICHMENT_DRY_RUN: committedVar("ENRICHMENT_DRY_RUN"),
      PROMOTER_ENRICHMENT_DRY_RUN: committedVar("PROMOTER_ENRICHMENT_DRY_RUN"),
    });
    expect(bodies).toEqual([{ promoterId: "fair", jobRunId, dryRun: false }]);

    const rows = await cands();
    const by = (f: string) => rows.find((r) => r.proposedField === f);

    // Positive landmark: an auto_merged row under a promoter-cron-* job run.
    expect(by("contact_email")?.decision).toBe("auto_merged");
    expect(by("contact_email")?.jobRunId).toBe(jobRunId);

    // A cron-found value that fails an OPE-1706 check still stages, flagged.
    expect(by("contact_phone")?.decision).toBe("pending");
    expect(JSON.parse(by("contact_phone")!.flags)).toContain("phone_region_mismatch");

    // Logos never auto-apply.
    expect(
      rows.filter((r) => r.decision === "auto_merged").map((r) => r.proposedField)
    ).not.toContain("logo");

    const [p] = await db.select().from(promoters).where(eq(promoters.id, "fair"));
    expect(p.contactEmail).toBe("hello@pinehillfair.example");
    expect(p.contactPhone).toBeNull();
  });

  it('the old behaviour, for contrast: shared flag alone ("true") stages everything, applies nothing', async () => {
    await seedMaineFair();
    const { bodies } = await runCron({ ENRICHMENT_DRY_RUN: "true" });
    expect(bodies[0].dryRun).toBe(true);
    const rows = await cands();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.decision === "pending")).toBe(true);
    const [p] = await db.select().from(promoters).where(eq(promoters.id, "fair"));
    expect(p.contactEmail).toBeNull();
  });
});
