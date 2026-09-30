/**
 * OPE-962 — NEEDS_ENRICHMENT gets an exit: EXHAUSTED after three consecutive
 * successful fetches that stage zero candidates. And the queue tool can order
 * by the gap a render can actually fill.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  computePromoterEnrichment,
  PROMOTER_ENRICHMENT_EXHAUST_AFTER,
} from "@takemetothefair/constants";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoters } from "../src/schema.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import { registerAdminTools } from "../src/tools/admin.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

/** A site that fetches fine and carries no extractable signal at all. */
const BARREN = "<html><head><title>Home</title></head><body><p>Welcome.</p></body></html>";
/** A site with a phone number — one stageable candidate. */
const HAS_PHONE = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Organization",
  telephone: "(207) 555-0100",
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
      .select({ status: promoters.enrichmentStatus, streak: promoters.enrichmentZeroYieldStreak })
      .from(promoters)
      .where(eq(promoters.id, id))
  )[0];
const run = (db: TestDb, id: string, dryRun = true) =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: id, jobRunId: "j", dryRun });

describe("OPE-962 — the zero-yield streak and EXHAUSTED", () => {
  it("the threshold is 3", () => {
    expect(PROMOTER_ENRICHMENT_EXHAUST_AFTER).toBe(3);
  });

  it("three zero-candidate attempts → EXHAUSTED on the third, not before", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push((await run(db, id)).outcome);
      if (i < 2) expect(await read(db, id)).toEqual({ status: "NEEDS_ENRICHMENT", streak: i + 1 });
    }
    expect(outcomes).toEqual(["staged", "staged", "exhausted"]);
    expect(await read(db, id)).toEqual({ status: "EXHAUSTED", streak: 3 });
  });

  it("an attempt that stages a candidate RESETS the streak", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    await run(db, id);
    await run(db, id);
    serve(HAS_PHONE);
    await run(db, id);
    expect(await read(db, id)).toEqual({ status: "NEEDS_ENRICHMENT", streak: 0 });
  });

  it("the LIVE path counts too", async () => {
    const { db } = createTestDb();
    const id = await seed(db);
    serve(BARREN);
    for (let i = 0; i < 3; i++) await run(db, id, false);
    expect((await read(db, id)).status).toBe("EXHAUSTED");
  });

  it("a FAILED fetch is BLOCKED, never counted toward EXHAUSTED", async () => {
    const { db } = createTestDb();
    const id = await seed(db, { website: "http://127.0.0.1/" }); // SSRF-blocked host
    for (let i = 0; i < 3; i++) await run(db, id);
    expect(await read(db, id)).toMatchObject({ status: "BLOCKED", streak: 0 });
  });

  it("an operator-owned IN_PROGRESS promoter is not moved to EXHAUSTED", async () => {
    const { db } = createTestDb();
    const id = await seed(db, { enrichmentStatus: "IN_PROGRESS" });
    serve(BARREN);
    for (let i = 0; i < 3; i++) await run(db, id);
    expect((await read(db, id)).status).toBe("IN_PROGRESS");
  });
});

describe("OPE-962 — computePromoterEnrichment", () => {
  const partial = { website: "https://x.example", contactPhone: "207" };
  it("EXHAUSTED is sticky on an edit that does not complete coverage", () => {
    expect(computePromoterEnrichment(partial, "EXHAUSTED").status).toBe("EXHAUSTED");
  });
  it("…but completing coverage still makes it ENRICHED", () => {
    const full = {
      website: "https://x.example",
      heroImageUrl: "h",
      logoUrl: "l",
      description: "A real organizer description that is long enough.",
      socialLinks: '["https://facebook.com/x"]',
      contactEmail: "a@b.c",
    };
    expect(computePromoterEnrichment(full, "EXHAUSTED").status).toBe("ENRICHED");
  });
  it("…and passing no current status (a website change) re-opens it", () => {
    expect(computePromoterEnrichment(partial, null).status).toBe("NEEDS_ENRICHMENT");
  });
});

describe("OPE-962 — update_promoter re-opens EXHAUSTED on a WEBSITE change only", () => {
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
      {
        MAIN_APP_URL: "https://m",
        INTERNAL_API_KEY: "k",
      } as never
    );
    mock = mockIndexNowFetch();
  });
  afterEach(() => mock.restore());

  it("a website change → NEEDS_ENRICHMENT with the streak reset", async () => {
    await seed(db, { enrichmentStatus: "EXHAUSTED", enrichmentZeroYieldStreak: 3 });
    await server.invoke("update_promoter", {
      promoter_id: "p1",
      website: "https://new.example.com",
    });
    expect(await read(db, "p1")).toEqual({ status: "NEEDS_ENRICHMENT", streak: 0 });
  });

  it("an unrelated edit leaves it EXHAUSTED", async () => {
    await seed(db, { enrichmentStatus: "EXHAUSTED", enrichmentZeroYieldStreak: 3 });
    await server.invoke("update_promoter", { promoter_id: "p1", contact_phone: "207-555-0100" });
    expect(await read(db, "p1")).toEqual({ status: "EXHAUSTED", streak: 3 });
  });
});

describe("OPE-962 — list_promoter_enrichment_queue order_by gap", () => {
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
      {
        MAIN_APP_URL: "https://m",
        INTERNAL_API_KEY: "k",
      } as never
    );
    mock = mockIndexNowFetch();
  });
  afterEach(() => mock.restore());

  const call = async (args: Record<string, unknown>) =>
    JSON.parse(
      (
        (await server.invoke("list_promoter_enrichment_queue", args)) as {
          content: Array<{ text: string }>;
        }
      ).content[0].text
    ) as { returned: number; promoters: Array<{ promoter_id: string; appliable_gap: number }> };

  it("orders by appliable gap, and a missing LOGO scores nothing", async () => {
    // full: every appliable field filled but NO logo → gap 0.
    await seed(db, {
      id: "full",
      heroImageUrl: "h",
      description: "A long, curated organizer description for this promoter.",
      socialLinks: '["https://facebook.com/x"]',
      contactEmail: "a@b.c",
      contactPhone: "207",
      logoUrl: null,
    });
    // two: hero + phone missing, placeholder description counts as missing → gap 3.
    await seed(db, {
      id: "three",
      description: "Event organizer.",
      socialLinks: '["https://facebook.com/x"]',
      contactEmail: "a@b.c",
    });
    // all five missing → gap 5.
    await seed(db, { id: "five" });

    const r = await call({ order_by: "gap" });
    expect(r.promoters.map((p) => [p.promoter_id, p.appliable_gap])).toEqual([
      ["five", 5],
      ["three", 3],
      ["full", 0],
    ]);
  });

  it("min_gap filters, and EXHAUSTED rows are never returned", async () => {
    await seed(db, { id: "five" });
    await seed(db, { id: "exhausted", enrichmentStatus: "EXHAUSTED" });
    await seed(db, {
      id: "one",
      heroImageUrl: "h",
      description: "A long, curated organizer description for this promoter.",
      socialLinks: '["https://facebook.com/x"]',
      contactEmail: "a@b.c",
    });
    const r = await call({ order_by: "gap", min_gap: 2 });
    expect(r.promoters.map((p) => p.promoter_id)).toEqual(["five"]);
  });
});
