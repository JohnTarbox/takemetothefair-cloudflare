/**
 * OPE-987 — the organizer-page cancellation recheck: who gets re-read, what a
 * hit writes, and what it must never write.
 *
 * Pages are the real fixtures from src/lib/goodwill/__tests__/fixtures/ope987,
 * served through an injected fetcher so no test touches the network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  CANCELLATION_HEARTBEAT_CODE,
  CANCELLATION_SOURCE_FIELD,
  runCancellationRecheck,
  selectCancellationRecheck,
  thirdPartyReason,
  type FetchedPage,
} from "../src/goodwill/cancellation-recheck.js";
import {
  agentHeartbeats,
  errorLogs,
  eventDiscrepancies,
  events,
  urlHealthChecks,
} from "../src/schema.js";

const FIX = join(__dirname, "../../src/lib/goodwill/__tests__/fixtures/ope987");
const CAPE_COD = readFileSync(join(FIX, "capecodbrewfest_com.html"), "utf8");
const DURHAM = readFileSync(join(FIX, "durhamfair_com.html"), "utf8");

const NOW = new Date("2026-09-13T12:00:00Z");
const DAY = 86_400_000;

let db: TestDb;

type EventSeed = Partial<typeof events.$inferInsert> & { id: string };

async function seed(e: EventSeed) {
  await db.insert(events).values({
    name: e.id,
    slug: e.id as never,
    promoterId: "p-1",
    status: "APPROVED",
    lifecycleStatus: "SCHEDULED",
    startDate: new Date(NOW.getTime() + 7 * DAY),
    sourceUrl: `https://${e.id}.example.org/`,
    sourceName: "vendor-submission",
    ...e,
  } as typeof events.$inferInsert);
}

function fetcherFrom(pages: Record<string, string | null>) {
  const calls: string[] = [];
  const fetchPage = async (url: string): Promise<FetchedPage> => {
    calls.push(url);
    const html = pages[url];
    return html
      ? { ok: true, status: 200, html }
      : { ok: false, status: 404, html: null, error: "http_404" };
  };
  return { fetchPage, calls };
}

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("thirdPartyReason", () => {
  it("an organizer's own domain is not third-party", () => {
    expect(thirdPartyReason("https://capecodbrewfest.com/", "vendor-submission")).toBeNull();
  });

  it("an aggregator host is excluded EVEN WHEN labelled vendor-submission (the measured leak)", () => {
    expect(
      thirdPartyReason(
        "https://www.fairsandfestivals.net/events/details/cornish-apple-festival",
        "vendor-submission"
      )
    ).toBe("aggregator");
  });

  it("DMO / tier-2 listing hosts are excluded", () => {
    expect(thirdPartyReason("https://ctvisit.com/events/x", "ctvisit.com")).not.toBeNull();
    expect(thirdPartyReason("https://www.mainemade.com/event/x/", "vendor-submission")).toBe(
      "aggregator"
    );
  });

  it("social and ticketing platforms are excluded", () => {
    expect(thirdPartyReason("https://www.facebook.com/applefest/", "vendor-submission")).toBe(
      "platform"
    );
    expect(thirdPartyReason("https://allevents.in/bangor/x/1", "vendor-submission")).toBe(
      "platform"
    );
    expect(thirdPartyReason("https://events.humanitix.com/brew-fest", null)).toBe("platform");
  });
});

describe("selectCancellationRecheck — who is re-read", () => {
  beforeEach(async () => {
    await seed({ id: "in-window" });
    await seed({ id: "tentative", status: "TENTATIVE", lifecycleStatus: "TENTATIVE" });
    await seed({
      id: "aggregator",
      sourceUrl: "https://www.fairsandfestivals.net/events/details/x",
    });
    await seed({ id: "facebook", sourceUrl: "https://www.facebook.com/somefair/" });
    await seed({ id: "out-of-window", startDate: new Date(NOW.getTime() + 31 * DAY) });
    await seed({ id: "already-started", startDate: new Date(NOW.getTime() - DAY) });
    await seed({ id: "already-cancelled", lifecycleStatus: "CANCELLED" });
    await seed({ id: "occurred", lifecycleStatus: "OCCURRED" });
    await seed({ id: "merged", mergedInto: "in-window" });
    await seed({ id: "pending", status: "PENDING" });
    await seed({ id: "rejected", status: "REJECTED" });
    await seed({ id: "no-url", sourceUrl: null });
    await seed({ id: "blank-url", sourceUrl: "" });
  });

  it("selects only in-window, live, organizer-sourced events", async () => {
    const sel = await selectCancellationRecheck(db, NOW, 50);
    const slugs = sel.batch.flatMap((b) => b.events.map((e) => e.slug)).sort();
    expect(slugs).toEqual(["in-window", "tentative"]);
    expect(sel.excludedThirdParty).toBe(2);
  });

  it("groups events sharing one url into one fetch", async () => {
    await seed({ id: "market-week-2", sourceUrl: "https://in-window.example.org/" });
    const sel = await selectCancellationRecheck(db, NOW, 50);
    const shared = sel.batch.find((b) => b.url === "https://in-window.example.org/");
    expect(shared?.events.map((e) => e.slug).sort()).toEqual(["in-window", "market-week-2"]);
  });

  it("bounds the batch and reports the remainder", async () => {
    const sel = await selectCancellationRecheck(db, NOW, 1);
    expect(sel.batch).toHaveLength(1);
    expect(sel.remaining).toBe(1);
  });
});

describe("runCancellationRecheck — a hit", () => {
  const URL = "https://capecodbrewfest.com/";

  beforeEach(async () => {
    await seed({ id: "cape-cod-brew-fest", sourceUrl: URL });
  });

  it("ACCEPTANCE: Cape Cod opens one status discrepancy, logs a warn, and records the read", async () => {
    const { fetchPage } = fetcherFrom({ [URL]: CAPE_COD });
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });

    expect(r).toMatchObject({ examined: 1, notices: 1, discrepanciesOpened: 1 });
    const rows = await db.select().from(eventDiscrepancies);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: "cape-cod-brew-fest",
      fieldClass: "status",
      detectedBy: "stale_page_radar",
      resolutionStatus: "open",
      divergentSourceUrl: URL,
      divergentSourceKey: "capecodbrewfest.com",
      authoritativeValue: "lifecycle_status=SCHEDULED",
      outreachCandidate: false,
    });
    expect(rows[0].divergentValue).toMatch(/^CANCELLED \(scope: unclear\) — '.*[Cc]ancel.*'$/);
    expect(rows[0].notes).toMatch(/scopes: .*year.*series|scopes: .*series.*year/);

    const checks = await db.select().from(urlHealthChecks);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      url: URL,
      sourceField: CANCELLATION_SOURCE_FIELD,
      verdict: "cancellation_notice",
    });

    const warns = await db.select().from(errorLogs);
    expect(warns.some((w) => w.level === "warn" && /announces cancellation/.test(w.message))).toBe(
      true
    );
  });

  it("NEVER modifies the event row", async () => {
    const [before] = await db.select().from(events).where(eq(events.id, "cape-cod-brew-fest"));
    const { fetchPage } = fetcherFrom({ [URL]: CAPE_COD });
    await runCancellationRecheck(db, { now: NOW, fetchPage });
    const [after] = await db.select().from(events).where(eq(events.id, "cape-cod-brew-fest"));
    expect(after).toEqual(before);
  });

  it("is idempotent: a later run re-reads the page but opens no second row", async () => {
    const { fetchPage, calls } = fetcherFrom({ [URL]: CAPE_COD });
    await runCancellationRecheck(db, { now: NOW, fetchPage });
    const later = new Date(NOW.getTime() + 21 * 3_600_000);
    const r2 = await runCancellationRecheck(db, { now: later, fetchPage });
    expect(calls).toHaveLength(2);
    expect(r2).toMatchObject({ discrepanciesOpened: 0, discrepanciesAlreadyOpen: 1 });
    expect(await db.select().from(eventDiscrepancies)).toHaveLength(1);
  });

  it("rotation: a url read within RECHECK_AFTER_HOURS is not fetched again", async () => {
    const { fetchPage, calls } = fetcherFrom({ [URL]: CAPE_COD });
    await runCancellationRecheck(db, { now: NOW, fetchPage });
    const r2 = await runCancellationRecheck(db, {
      now: new Date(NOW.getTime() + 3_600_000),
      fetchPage,
    });
    expect(calls).toHaveLength(1);
    expect(r2).toMatchObject({ examined: 0, recentlyChecked: 1, remaining: 0 });
  });

  it("skips an event whose row is already CANCELLED (the hand-fixed specimen)", async () => {
    await db
      .update(events)
      .set({ lifecycleStatus: "CANCELLED" })
      .where(eq(events.id, "cape-cod-brew-fest"));
    const { fetchPage, calls } = fetcherFrom({ [URL]: CAPE_COD });
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(calls).toHaveLength(0);
    expect(r.examined).toBe(0);
  });
});

describe("runCancellationRecheck — no hit, failures, and the run stamp", () => {
  it("control: a live organizer page opens nothing and records a clean read", async () => {
    await seed({ id: "durham-fair-2026", sourceUrl: "https://www.durhamfair.com/" });
    const { fetchPage } = fetcherFrom({ "https://www.durhamfair.com/": DURHAM });
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(r).toMatchObject({ examined: 1, notices: 0, discrepanciesOpened: 0 });
    expect(await db.select().from(eventDiscrepancies)).toHaveLength(0);
    const [check] = await db.select().from(urlHealthChecks);
    expect(check.verdict).toBe("no_cancellation_notice");
  });

  it("a failed fetch is recorded and opens nothing", async () => {
    await seed({ id: "gone" });
    const { fetchPage } = fetcherFrom({});
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(r).toMatchObject({ examined: 1, fetchFailed: 1, notices: 0 });
    const [check] = await db.select().from(urlHealthChecks);
    expect(check.verdict).toBe("fetch_failed");
    expect(await db.select().from(eventDiscrepancies)).toHaveLength(0);
  });

  it("stamps the heartbeat on a run with NOTHING to check", async () => {
    const { fetchPage } = fetcherFrom({});
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(r).toMatchObject({ inWindow: 0, examined: 0 });
    const [hb] = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, CANCELLATION_HEARTBEAT_CODE));
    expect(hb.lastSeenAt.getTime()).toBe(NOW.getTime());
    expect(hb.note).toMatch(/examined=0/);
  });

  it("re-stamps on every run (the stamp moves forward)", async () => {
    const { fetchPage } = fetcherFrom({});
    await runCancellationRecheck(db, { now: NOW, fetchPage });
    const later = new Date(NOW.getTime() + DAY);
    await runCancellationRecheck(db, { now: later, fetchPage });
    const hbs = await db.select().from(agentHeartbeats);
    expect(hbs).toHaveLength(1);
    expect(hbs[0].lastSeenAt.getTime()).toBe(later.getTime());
  });
});
