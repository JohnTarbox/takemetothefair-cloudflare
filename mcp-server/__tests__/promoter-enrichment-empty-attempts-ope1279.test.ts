/**
 * OPE-1279 — the promoter-enrichment queue never drained.
 *
 * OPE-962 exhausted a promoter after 3 consecutive attempts that staged ZERO
 * candidates. In prod that never fired (0 EXHAUSTED rows, queue 636 on
 * 2026-10-15): a site that re-proposes the SAME unreviewed/flagged value every
 * run stages a candidate every run, so the streak reset forever.
 *
 * Now: a LIVE attempt that applies no field AND stages no NEW candidate is
 * empty; two consecutive empty live attempts → EXHAUSTED.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { PROMOTER_ENRICHMENT_EXHAUST_AFTER } from "@takemetothefair/constants";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoters, promoterEnrichmentCandidates } from "../src/schema.js";
import {
  countNewCandidates,
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerPromoterEnrichmentReviewTools } from "../src/tools/admin-promoter-enrichment-review.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

/** Fetches fine, carries no extractable signal. */
const BARREN = "<html><head><title>Home</title></head><body><p>Welcome.</p></body></html>";
/** A phone only in body text: regex-sourced (0.45), staged every run, never auto-applied. */
const TEXT_PHONE =
  "<html><head><title>Home</title></head><body><p>Call us at (207) 778-4123 today.</p></body></html>";
/** A real-looking JSON-LD phone: auto-applied on a live run. */
const REAL_PHONE = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Organization",
  telephone: "(207) 778-4123",
})}</script>`;

let restore: (() => void) | null = null;
function serve(html: string) {
  restore?.();
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  restore = () => (globalThis.fetch = orig);
}
afterEach(() => {
  restore?.();
  restore = null;
});

async function seed(db: TestDb, over: Partial<typeof promoters.$inferInsert> = {}) {
  const id = over.id ?? "p1";
  await db.insert(promoters).values({
    id,
    companyName: "Barren Promotions",
    slug: `slug-${id}`,
    website: "https://barren.example.com",
    enrichmentStatus: "NEEDS_ENRICHMENT",
    ...over,
  } as never);
  return id;
}
const read = async (db: TestDb, id: string) =>
  (
    await db
      .select({
        status: promoters.enrichmentStatus,
        empty: promoters.enrichmentEmptyAttempts,
        streak: promoters.enrichmentZeroYieldStreak,
        phone: promoters.contactPhone,
        attemptedAt: promoters.enrichmentAttemptedAt,
        blockedReason: promoters.enrichmentBlockedReason,
      })
      .from(promoters)
      .where(eq(promoters.id, id))
  )[0];
const live = (db: TestDb, id: string) =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: id, jobRunId: "j", dryRun: false });
const dry = (db: TestDb, id: string) =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: id, jobRunId: "j", dryRun: true });

describe("OPE-1279 — consecutive empty LIVE attempts → EXHAUSTED", () => {
  it("the threshold is 2", () => {
    expect(PROMOTER_ENRICHMENT_EXHAUST_AFTER).toBe(2);
  });

  it("two empty live attempts → EXHAUSTED on the second, not the first", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    const first = await live(db, id);
    expect(first).toMatchObject({ outcome: "merged", emptyAttempts: 1, newCandidateCount: 0 });
    expect(await read(db, id)).toMatchObject({ status: "NEEDS_ENRICHMENT", empty: 1 });
    const second = await live(db, id);
    expect(second).toMatchObject({ outcome: "exhausted", emptyAttempts: 2 });
    expect(await read(db, id)).toMatchObject({ status: "EXHAUSTED", empty: 2 });
  });

  it("ROOT CAUSE: the SAME never-applied candidate re-staged every run is not progress", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(TEXT_PHONE);
    // Run 1 stages the phone for the first time → new → not empty.
    const r1 = await live(db, id);
    expect(r1).toMatchObject({ candidateCount: 1, newCandidateCount: 1, emptyAttempts: 0 });
    expect(r1.appliedFields).toEqual([]);
    // Runs 2 and 3 re-stage the identical value: empty, empty → EXHAUSTED.
    const r2 = await live(db, id);
    expect(r2).toMatchObject({ candidateCount: 1, newCandidateCount: 0, emptyAttempts: 1 });
    const r3 = await live(db, id);
    expect(r3.outcome).toBe("exhausted");
    // The OPE-962 streak never moved — that is why prod had 0 EXHAUSTED rows.
    expect(await read(db, id)).toMatchObject({ status: "EXHAUSTED", empty: 2, streak: 0 });
  });

  it("a NEW candidate resets the count", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    await live(db, id);
    serve(TEXT_PHONE);
    await live(db, id);
    expect(await read(db, id)).toMatchObject({ status: "NEEDS_ENRICHMENT", empty: 0 });
  });

  it("a promoter that gains an APPLIED field never goes EXHAUSTED on that run, and restarts at 0", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    await live(db, id); // empty 1 — one away from EXHAUSTED
    serve(REAL_PHONE);
    // The nightly DRY run stages the phone first, so the live apply below is NOT
    // a new candidate — the applied field alone must reset the count.
    await dry(db, id);
    const applied = await live(db, id);
    expect(applied.newCandidateCount).toBe(0);
    expect(applied.appliedFields).toEqual(["contact_phone"]);
    expect(applied.outcome).toBe("merged");
    expect(await read(db, id)).toMatchObject({
      status: "NEEDS_ENRICHMENT",
      empty: 0,
      phone: "(207) 778-4123",
    });
    serve(BARREN);
    await live(db, id); // the count restarts: 1, still queued
    expect(await read(db, id)).toMatchObject({ status: "NEEDS_ENRICHMENT", empty: 1 });
  });

  it("a candidate a human REJECTED is re-proposed but is not new — it cannot hold the row in the queue", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(REAL_PHONE);
    await dry(db, id); // stage it once
    await db
      .update(promoterEnrichmentCandidates)
      .set({ decision: "rejected", reviewedBy: "admin" })
      .where(eq(promoterEnrichmentCandidates.promoterId, id));
    const r1 = await live(db, id);
    expect(r1.appliedFields).toEqual([]); // the veto holds
    expect(r1.newCandidateCount).toBe(0);
    await live(db, id);
    expect(await read(db, id)).toMatchObject({ status: "EXHAUSTED", phone: null });
  });

  it("DRY runs never count toward EXHAUSTED", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    for (let i = 0; i < 4; i++) expect((await dry(db, id)).outcome).toBe("staged");
    expect(await read(db, id)).toMatchObject({ status: "NEEDS_ENRICHMENT", empty: 0, streak: 4 });
  });

  it("operator-owned IN_PROGRESS is never moved to EXHAUSTED", async () => {
    const { db } = createTestDb();
    const id = await seed(db, { enrichmentStatus: "IN_PROGRESS" });
    serve(BARREN);
    for (let i = 0; i < 3; i++) await live(db, id);
    expect(await read(db, id)).toMatchObject({ status: "IN_PROGRESS", empty: 3 });
  });
});

describe("OPE-1279 — countNewCandidates", () => {
  const prior = [
    { field: "contact_phone", value: "(207) 555-0100" },
    { field: "logo", value: "https://x/logo.png" },
  ];
  it("a (field, value) seen under any decision is not new; a new value or field is", () => {
    expect(
      countNewCandidates(
        [
          { field: "contact_phone", proposedValue: "(207) 555-0100" },
          { field: "contact_phone", proposedValue: "(207) 555-0199" },
          { field: "hero", proposedValue: "https://x/logo.png" },
        ],
        prior
      )
    ).toBe(2);
  });
  it("no proposals → 0", () => {
    expect(countNewCandidates([], prior)).toBe(0);
  });
});

describe("OPE-1279 — update_promoter requeue_enrichment", () => {
  let db: TestDb;
  let server: CapturingMcpServer;
  let mock: ReturnType<typeof mockIndexNowFetch>;
  beforeEach(() => {
    ({ db } = createTestDb());
    server = new CapturingMcpServer();
    registerAdminTools(
      server as never,
      db,
      { userId: "u", role: "ADMIN" } as never,
      { MAIN_APP_URL: "https://m", INTERNAL_API_KEY: "k" } as never
    );
    mock = mockIndexNowFetch();
  });
  afterEach(() => mock.restore());

  it("alone, moves EXHAUSTED back to NEEDS_ENRICHMENT, resets the count and the attempt stamp", async () => {
    await seed(db, {
      enrichmentStatus: "EXHAUSTED",
      enrichmentEmptyAttempts: 2,
      enrichmentZeroYieldStreak: 2,
      enrichmentAttemptedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const res = (await server.invoke("update_promoter", {
      promoter_id: "p1",
      requeue_enrichment: true,
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).enrichmentStatus).toBe("NEEDS_ENRICHMENT");
    expect(await read(db, "p1")).toMatchObject({
      status: "NEEDS_ENRICHMENT",
      empty: 0,
      streak: 0,
      attemptedAt: null,
    });
  });

  it("re-opens BLOCKED too and clears the stale blocked reason", async () => {
    await seed(db, { enrichmentStatus: "BLOCKED", enrichmentBlockedReason: "js_gated" });
    await server.invoke("update_promoter", { promoter_id: "p1", requeue_enrichment: true });
    expect(await read(db, "p1")).toMatchObject({
      status: "NEEDS_ENRICHMENT",
      blockedReason: null,
    });
  });

  it("without the flag, an unrelated edit leaves EXHAUSTED and its count alone", async () => {
    await seed(db, { enrichmentStatus: "EXHAUSTED", enrichmentEmptyAttempts: 2 });
    await server.invoke("update_promoter", { promoter_id: "p1", city: "Bangor" });
    expect(await read(db, "p1")).toMatchObject({ status: "EXHAUSTED", empty: 2 });
  });

  it("a website change also resets the empty-attempt count", async () => {
    await seed(db, { enrichmentStatus: "EXHAUSTED", enrichmentEmptyAttempts: 2 });
    await server.invoke("update_promoter", {
      promoter_id: "p1",
      website: "https://new.example.com",
    });
    expect(await read(db, "p1")).toMatchObject({ status: "NEEDS_ENRICHMENT", empty: 0 });
  });
});

describe("OPE-1279 — list_promoter_enrichment_queue reports empty_attempts", () => {
  it("each row carries its consecutive empty live attempts", async () => {
    const { db } = createTestDb();
    const server = new CapturingMcpServer();
    registerPromoterEnrichmentReviewTools(server as never, db, {
      userId: "u",
      role: "ADMIN",
    } as never);
    await seed(db, { id: "one", enrichmentEmptyAttempts: 1 });
    const res = (await server.invoke("list_promoter_enrichment_queue", {})) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(res.content[0].text) as {
      promoters: Array<{ promoter_id: string; empty_attempts: number }>;
    };
    expect(body.promoters).toEqual([
      expect.objectContaining({ promoter_id: "one", empty_attempts: 1 }),
    ]);
  });
});
