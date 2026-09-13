/**
 * OPE-979 — succession on promoters: recording that one stopped trading, what it
 * still owns, and that enrichment + rollover stop treating it as alive.
 *
 * Seeded from the prod specimen as it stood the day BEFORE the manual fix
 * (2026-09-12): Eagle Shows APPROVED/SCHEDULED Marlborough on Sept 19, and a
 * second Marlborough row under the community-suggestions placeholder whose only
 * link to Eagle Shows is source_domain = eagleshows.com.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { eventSeries, events, promoters } from "../src/schema.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerPromoterBlastRadiusTool } from "../src/tools/admin-promoter-blast-radius.js";
import { rolloverEventIfRecurring } from "../src/event-rollover.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";

const holder: { db: TestDb | null } = { db: null };
vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<typeof import("../src/db.js")>()),
  getDb: () => holder.db,
}));
const { runScheduledPromoterEnrichment } = await import("../src/enrichment/promoter-select.js");

const EAGLE = "9703b5c0-43d9-4b8f-b87a-56180d50f089";
const EASTERN = "a47e02d4-1ed2-44db-8d26-629ad5e1a06d";
const COMMUNITY = "system-community-suggestions";
const MARLBOROUGH = "7e294fa4-7413-4ca4-bc89-ca305cbedbe7";
const COMMUNITY_ROW = "93884c6f-e136-450f-9bfb-2d4f175bc180";
const SERIES = "f66358b59ec47705653d3497156bc137";
const DAY_BEFORE_FIX = "2026-09-12T12:00:00.000Z";
const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://meetmeatthefair.com",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

let db: TestDb;
let server: CapturingMcpServer;
let indexNow: ReturnType<typeof mockIndexNowFetch>;

function seedEvent(id: string, v: Partial<typeof events.$inferInsert>) {
  db.insert(events)
    .values({
      id,
      name: id,
      slug: unsafeSlug(id),
      promoterId: EAGLE,
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      startDate: new Date("2026-09-19T12:00:00Z"),
      endDate: new Date("2026-09-20T12:00:00Z"),
      ...v,
    } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  holder.db = db;
  indexNow = mockIndexNowFetch();
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN, ENV as never);
  registerPromoterBlastRadiusTool(server as never, db, ADMIN);

  for (const [id, name, website] of [
    [EAGLE, "Eagle Shows", "https://eagleshows.com"],
    [EASTERN, "Eastern Gun Expo", "https://easterngunexpo.com"],
    [COMMUNITY, "Community Suggestions", null],
  ] as const) {
    db.insert(promoters)
      .values({
        id,
        companyName: name,
        slug: unsafeSlug(id),
        website,
        enrichmentStatus: website ? "NEEDS_ENRICHMENT" : null,
      } as never)
      .run();
  }
  db.insert(eventSeries)
    .values({
      id: SERIES,
      canonicalSlug: unsafeSlug("marlborough-gun-show"),
      name: "Marlborough Gun Show",
      promoterId: EAGLE,
    } as never)
    .run();

  seedEvent(MARLBOROUGH, {
    name: "Marlborough Gun Show - September 2026",
    seriesId: SERIES,
    sourceDomain: "eagleshows.com",
  });
  seedEvent(COMMUNITY_ROW, {
    name: "Marlborough Gun Show (Fall)",
    promoterId: COMMUNITY,
    status: "REJECTED",
    sourceDomain: "eagleshows.com",
  });
  // Must NOT appear: finished, a merge tombstone, and someone else's show.
  seedEvent("eagle-past", {
    startDate: new Date("2026-03-01T12:00:00Z"),
    endDate: new Date("2026-03-02T12:00:00Z"),
  });
  seedEvent("eagle-tombstone", { mergedInto: MARLBOROUGH, status: "REJECTED" });
  seedEvent("eastern-morgantown", { promoterId: EASTERN, sourceDomain: "easterngunexpo.com" });
});
afterEach(() => indexNow.restore());

async function tool(name: string, args: Record<string, unknown>) {
  const r = (await server.invoke(name, args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  let body: Record<string, any>;
  try {
    body = JSON.parse(r.content[0].text);
  } catch {
    body = { text: r.content[0].text };
  }
  return { ...body, isError: r.isError === true };
}
const promoter = (id: string) => db.select().from(promoters).where(eq(promoters.id, id)).all()[0];

describe("OPE-979 — get_promoter_blast_radius", () => {
  it("ACCEPTANCE: run against Eagle Shows as of the day before the fix, it returns 7e294fa4", async () => {
    const r = await tool("get_promoter_blast_radius", {
      promoter_id: EAGLE,
      as_of: DAY_BEFORE_FIX,
    });
    expect(r.isError).toBe(false);
    const byId = Object.fromEntries(r.future_events.map((e: any) => [e.id, e]));
    expect(byId[MARLBOROUGH]).toMatchObject({
      listed_publicly: true,
      matched_by: ["promoter_id", "series", "source_domain"],
    });
    expect(r.series).toEqual([
      { id: SERIES, name: "Marlborough Gun Show", canonicalSlug: "marlborough-gun-show" },
    ]);
  });

  it("reaches the row nothing else points at — by source_domain alone — and marks it", async () => {
    const r = await tool("get_promoter_blast_radius", {
      promoter_id: EAGLE,
      as_of: DAY_BEFORE_FIX,
    });
    const community = r.future_events.find((e: any) => e.id === COMMUNITY_ROW);
    expect(community).toMatchObject({
      matched_by: ["source_domain"],
      listed_publicly: false,
      status: "REJECTED",
    });
    expect(r.website_host).toBe("eagleshows.com");
    expect(r.summary).toEqual({
      futureEvents: 2,
      listedPublicly: 1,
      series: 1,
      reachableOnlyBySourceDomain: 1,
    });
  });

  it("excludes finished events, merge tombstones and other promoters' shows", async () => {
    const r = await tool("get_promoter_blast_radius", {
      promoter_id: EAGLE,
      as_of: DAY_BEFORE_FIX,
    });
    const ids = r.future_events.map((e: any) => e.id).sort();
    expect(ids).toEqual([COMMUNITY_ROW, MARLBOROUGH].sort());
  });

  it("a www. website still matches a bare source_domain", async () => {
    db.update(promoters)
      .set({ website: "https://WWW.EagleShows.com/" })
      .where(eq(promoters.id, EAGLE))
      .run();
    const r = await tool("get_promoter_blast_radius", {
      promoter_id: EAGLE,
      as_of: DAY_BEFORE_FIX,
    });
    expect(r.summary.reachableOnlyBySourceDomain).toBe(1);
  });
});

describe("OPE-979 — update_promoter records succession", () => {
  const ceased = {
    promoter_id: EAGLE,
    operating_status: "CEASED",
    succeeded_by_promoter_id: EASTERN,
    operating_status_source_url: "https://eagleshows.com/",
  };

  it("ACCEPTANCE: Eagle Shows reads CEASED → Eastern Gun Expo, sourced and stamped; both rows stay", async () => {
    const r = await tool("update_promoter", ceased);
    expect(r.isError).toBe(false);
    const p = promoter(EAGLE);
    expect(p).toMatchObject({
      operatingStatus: "CEASED",
      succeededByPromoterId: EASTERN,
      operatingStatusSourceUrl: "https://eagleshows.com/",
    });
    expect(p.operatingStatusVerifiedAt).toBeInstanceOf(Date);
    expect(promoter(EASTERN).companyName).toBe("Eastern Gun Expo"); // not a merge
  });

  it("refuses CEASED with no source URL, and writes nothing", async () => {
    const { operating_status_source_url: _omit, ...noUrl } = ceased;
    const r = await tool("update_promoter", noUrl);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/operating_status_source_url/);
    expect(promoter(EAGLE).operatingStatus).toBeNull();
  });

  it("refuses a successor that is itself, or that does not exist", async () => {
    expect(
      (await tool("update_promoter", { ...ceased, succeeded_by_promoter_id: EAGLE })).isError
    ).toBe(true);
    expect(
      (await tool("update_promoter", { ...ceased, succeeded_by_promoter_id: "nope" })).isError
    ).toBe(true);
    expect(promoter(EAGLE).succeededByPromoterId).toBeNull();
  });

  it("refuses a successor on a promoter that is not CEASED or MERGED", async () => {
    const r = await tool("update_promoter", {
      promoter_id: EAGLE,
      succeeded_by_promoter_id: EASTERN,
    });
    expect(r.isError).toBe(true);
    expect(promoter(EAGLE).succeededByPromoterId).toBeNull();
  });

  it("a status set earlier carries its source URL into a later successor-only call", async () => {
    await tool("update_promoter", {
      promoter_id: EAGLE,
      operating_status: "CEASED",
      operating_status_source_url: "https://eagleshows.com/",
    });
    const r = await tool("update_promoter", {
      promoter_id: EAGLE,
      succeeded_by_promoter_id: EASTERN,
    });
    expect(r.isError).toBe(false);
    expect(promoter(EAGLE).succeededByPromoterId).toBe(EASTERN);
  });
});

describe("OPE-979 — a CEASED promoter is not re-enriched", () => {
  const markCeased = () =>
    db
      .update(promoters)
      .set({ operatingStatus: "CEASED", operatingStatusSourceUrl: "https://eagleshows.com/" })
      .where(eq(promoters.id, EAGLE))
      .run();

  it("ACCEPTANCE: the nightly selector skips it; POSITIVE LANDMARK: still enqueues the live one", async () => {
    markCeased();
    const sent: string[] = [];
    const queue = {
      sendBatch: async (msgs: Array<{ body: { promoterId: string } }>) => {
        sent.push(...msgs.map((m) => m.body.promoterId));
      },
    };
    await runScheduledPromoterEnrichment(
      { DB: {} as D1Database, PROMOTER_ENRICHMENT: queue as never },
      "job-1",
      Date.now()
    );
    expect(sent).toEqual([EASTERN]);
  });

  it("ACCEPTANCE: the dispatcher (queue AND enrich_promoter) returns 'ceased' without fetching or writing", async () => {
    markCeased();
    const before = promoter(EAGLE);
    const orig = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      throw new Error("must not fetch");
    }) as typeof fetch;
    try {
      const r = await processPromoterEnrichmentJob(db, ENV, {
        promoterId: EAGLE,
        jobRunId: "j1",
        dryRun: false,
      });
      expect(r.outcome).toBe("ceased");
    } finally {
      globalThis.fetch = orig;
    }
    expect(fetched.filter((u) => u.includes("eagleshows"))).toEqual([]);
    const after = promoter(EAGLE);
    expect(after.enrichmentStatus).toBe(before.enrichmentStatus);
    expect(after.enrichmentAttemptedAt).toEqual(before.enrichmentAttemptedAt);
  });
});

describe("OPE-979 — a CEASED promoter's show is not rolled into next year", () => {
  const seedOccurred = (id: string, promoterId: string) =>
    seedEvent(id, {
      promoterId,
      lifecycleStatus: "OCCURRED",
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
      startDate: new Date("2026-03-01T12:00:00Z"),
      endDate: new Date("2026-03-02T12:00:00Z"),
    });

  it("ACCEPTANCE: skipReason promoter-ceased; POSITIVE LANDMARK: an ACTIVE promoter's show still rolls", async () => {
    db.update(promoters).set({ operatingStatus: "CEASED" }).where(eq(promoters.id, EAGLE)).run();
    seedOccurred("eagle-spring", EAGLE);
    seedOccurred("eastern-spring", EASTERN);
    const opts = { via: "cron" as const, actorUserId: null, now: new Date("2026-09-13T00:00:00Z") };

    expect(await rolloverEventIfRecurring(db, "eagle-spring", opts)).toEqual({
      created: false,
      skipReason: "promoter-ceased",
    });
    expect((await rolloverEventIfRecurring(db, "eastern-spring", opts)).created).toBe(true);
  });
});
