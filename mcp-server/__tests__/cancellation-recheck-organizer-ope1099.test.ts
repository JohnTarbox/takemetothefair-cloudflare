/**
 * OPE-1099 — the organizer-page recheck, when `source_url` is somebody else's.
 *
 * The specimen: `firefly-yoga-wellness-festival-2026`, sourced from
 * visitrhodeisland.com, promoter `system-community-suggestions`. Its organizer
 * cancelled it; the DMO listing kept advertising it; and the OPE-987 recheck
 * dropped it from the pass entirely, because its source_url was third-party —
 * leaving nothing but a `thirdParty=22` count in a heartbeat note.
 *
 * Measured on prod 2026-09-23 (171 events in the 30-day window): 23 had a
 * third-party source_url; 5 of those carry an organizer-owned url somewhere
 * else on the row; 18 carry none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  CANCELLATION_SOURCE_FIELD,
  NO_ORGANIZER_PAGE_SOURCE_FIELD,
  THIRD_PARTY_STALENESS_SOURCE_FIELD,
  pickOrganizerUrl,
  runCancellationRecheck,
  selectCancellationRecheck,
  type FetchedPage,
} from "../src/goodwill/cancellation-recheck.js";
import {
  eventDataCitations,
  eventDiscrepancies,
  events,
  promoters,
  urlHealthChecks,
} from "../src/schema.js";

const FIX = join(__dirname, "../../src/lib/goodwill/__tests__/fixtures/ope987");
const CANCELLED_PAGE = readFileSync(join(FIX, "capecodbrewfest_com.html"), "utf8");
const LIVE_PAGE = readFileSync(join(FIX, "durhamfair_com.html"), "utf8");

const NOW = new Date("2026-09-13T12:00:00Z");
const DAY = 86_400_000;
const DMO = "https://www.visitrhodeisland.com/event/firefly-yoga-%26-wellness-festival/109700/";
const ORGANIZER = "https://www.tivertonfarmersmarket.com/";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];

async function seedEvent(e: Partial<typeof events.$inferInsert> & { id: string }) {
  await db.insert(events).values({
    name: e.id,
    slug: e.id as never,
    promoterId: "system-community-suggestions",
    status: "APPROVED",
    lifecycleStatus: "SCHEDULED",
    startDate: new Date(NOW.getTime() + 6 * DAY),
    sourceUrl: DMO,
    sourceName: "www.visitrhodeisland.com",
    ...e,
  } as typeof events.$inferInsert);
}

async function seedPromoter(id: string, website: string | null) {
  await db
    .insert(promoters)
    .values({ id, companyName: id, slug: id as never, website } as typeof promoters.$inferInsert);
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

beforeEach(async () => {
  ({ db, raw } = createTestDb());
  await seedPromoter("system-community-suggestions", "https://meetmeatthefair.com/");
});

describe("pickOrganizerUrl — which page on the row is the organizer's", () => {
  const base = {
    sourceUrl: DMO,
    sourceName: "www.visitrhodeisland.com",
    promoterId: "p-tiverton",
    promoterWebsite: null,
    citationUrls: [],
    ticketUrl: null,
    applicationUrl: null,
  };

  it("an organizer-owned source_url is used as-is (every pre-OPE-1099 case)", () => {
    expect(pickOrganizerUrl({ ...base, sourceUrl: ORGANIZER, sourceName: null })).toEqual({
      url: ORGANIZER,
      via: "source_url",
    });
  });

  it("a third-party source falls through to the promoter's own website", () => {
    expect(pickOrganizerUrl({ ...base, promoterWebsite: ORGANIZER })).toEqual({
      url: ORGANIZER,
      via: "promoter_website",
    });
  });

  it("never uses a system-* placeholder promoter's website — it describes no event", () => {
    expect(
      pickOrganizerUrl({
        ...base,
        promoterId: "system-community-suggestions",
        promoterWebsite: "https://meetmeatthefair.com/",
      })
    ).toBeNull();
  });

  it("then a citation, then ticket and application urls — each must itself be first-party", () => {
    expect(
      pickOrganizerUrl({
        ...base,
        citationUrls: ["https://www.discovernewport.org/event/x/64651/", ORGANIZER],
      })
    ).toEqual({ url: ORGANIZER, via: "citation" });
    expect(pickOrganizerUrl({ ...base, ticketUrl: "https://www.eventbrite.com/e/123" })).toBeNull();
    expect(pickOrganizerUrl({ ...base, applicationUrl: ORGANIZER })).toEqual({
      url: ORGANIZER,
      via: "application_url",
    });
  });

  it("the specimen as it actually was: nothing on the row is the organizer's", () => {
    expect(
      pickOrganizerUrl({
        ...base,
        promoterId: "system-community-suggestions",
        promoterWebsite: "https://meetmeatthefair.com/",
      })
    ).toBeNull();
  });
});

describe("selection — third-party-sourced events are rescued or NAMED, never silently dropped", () => {
  it("an event whose promoter has a real site is read via that site", async () => {
    await seedPromoter("p-tiverton", ORGANIZER);
    await seedEvent({ id: "firefly-rescued", promoterId: "p-tiverton" });
    const sel = await selectCancellationRecheck(db, NOW, 50);
    expect(sel.excludedThirdParty).toBe(1);
    expect(sel.rescuedViaAlternate).toBe(1);
    expect(sel.unverifiable).toEqual([]);
    expect(sel.batch).toHaveLength(1);
    expect(sel.batch[0].url).toBe(ORGANIZER);
    expect(sel.batch[0].events[0]).toMatchObject({ via: "promoter_website", sourceUrl: DMO });
  });

  it("an active citation from the organizer rescues it too; a superseded one does not", async () => {
    await seedEvent({ id: "firefly-cited" });
    await db.insert(eventDataCitations).values({
      eventId: "firefly-cited",
      fieldName: "lifecycle_status",
      value: "CANCELLED",
      sourceUrl: "https://www.tivertonfarmersmarket.com/firefly",
      sourceType: "official_website",
      state: "superseded",
    } as typeof eventDataCitations.$inferInsert);
    expect((await selectCancellationRecheck(db, NOW, 50)).unverifiable).toHaveLength(1);

    await db
      .update(eventDataCitations)
      .set({ state: "active" })
      .where(eq(eventDataCitations.eventId, "firefly-cited"));
    const sel = await selectCancellationRecheck(db, NOW, 50);
    expect(sel.unverifiable).toEqual([]);
    expect(sel.batch[0]).toMatchObject({ url: "https://www.tivertonfarmersmarket.com/firefly" });
  });

  it("the specimen is NAMED as unverifiable, with the reason its source was refused", async () => {
    await seedEvent({ id: "firefly-yoga-wellness-festival-2026" });
    const sel = await selectCancellationRecheck(db, NOW, 50);
    expect(sel.batch).toEqual([]);
    expect(sel.unverifiable.map((u) => [u.slug, u.sourceUrl])).toEqual([
      ["firefly-yoga-wellness-festival-2026", DMO],
    ]);
    // Landmark: it WAS in the window — the empty batch is not an empty query.
    expect(sel.inWindow).toBe(1);
  });

  it("citation lookups stay under D1's 100-parameter cap on a busy window", async () => {
    // Asserted on statement SHAPE: better-sqlite3 accepts 32,766 bind params,
    // so "150 rows, no throw" would pass with the bug in. Every citation
    // lookup's placeholders are counted instead.
    for (let i = 0; i < 150; i++) await seedEvent({ id: `agg-${i}`, sourceUrl: `${DMO}?n=${i}` });
    const prepared: string[] = [];
    const realPrepare = raw.prepare.bind(raw);
    raw.prepare = ((source: string) => {
      prepared.push(source);
      return realPrepare(source);
    }) as typeof raw.prepare;
    try {
      const sel = await selectCancellationRecheck(db, NOW, 50);
      expect(sel.unverifiable).toHaveLength(150);
    } finally {
      raw.prepare = realPrepare;
    }
    const lookups = prepared.filter((q) =>
      /from "event_data_citations" where .*"event_data_citations"\."event_id" in/i.test(q)
    );
    // Landmark: 150 ids really were split — one statement would mean no chunking.
    expect(lookups.length).toBeGreaterThanOrEqual(2);
    for (const q of lookups) expect((q.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
  });
});

describe("the run — the gap is written down, and the listing's staleness is measured", () => {
  it("records each unverifiable event once per rotation window, by slug", async () => {
    await seedEvent({ id: "firefly-yoga-wellness-festival-2026" });
    const { fetchPage, calls } = fetcherFrom({});

    const first = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(first.unverifiable).toEqual(["firefly-yoga-wellness-festival-2026"]);
    expect(first.unverifiableRecorded).toBe(1);
    expect(calls).toEqual([]); // nothing to read — and nothing pretends it was read

    const second = await runCancellationRecheck(db, {
      now: new Date(NOW.getTime() + 3_600_000),
      fetchPage,
    });
    expect(second.unverifiableRecorded).toBe(0);

    const rows = await db
      .select()
      .from(urlHealthChecks)
      .where(eq(urlHealthChecks.sourceField, NO_ORGANIZER_PAGE_SOURCE_FIELD));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: DMO, verdict: "no_organizer_page" });
    expect(rows[0].detail).toContain("firefly-yoga-wellness-festival-2026");
  });

  it("ACCEPTANCE: organizer says cancelled, DMO still advertises it — both facts recorded", async () => {
    await seedPromoter("p-tiverton", ORGANIZER);
    await seedEvent({ id: "firefly", promoterId: "p-tiverton" });
    const { fetchPage, calls } = fetcherFrom({ [ORGANIZER]: CANCELLED_PAGE, [DMO]: LIVE_PAGE });

    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });

    expect(calls).toEqual([ORGANIZER, DMO]);
    expect(r.notices).toBe(1);
    expect(r.discrepanciesOpened).toBe(1);
    expect(r.thirdPartyStillLive).toBe(1);
    expect(r.thirdPartyCaughtUp).toBe(0);

    const stale = await db
      .select()
      .from(urlHealthChecks)
      .where(eq(urlHealthChecks.sourceField, THIRD_PARTY_STALENESS_SOURCE_FIELD));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ url: DMO, verdict: "third_party_still_live" });

    const organizerRead = await db
      .select()
      .from(urlHealthChecks)
      .where(
        and(
          eq(urlHealthChecks.sourceField, CANCELLATION_SOURCE_FIELD),
          eq(urlHealthChecks.url, ORGANIZER)
        )
      );
    expect(organizerRead[0]?.verdict).toBe("cancellation_notice");
  });

  it("a listing that had caught up is counted as such", async () => {
    await seedPromoter("p-tiverton", ORGANIZER);
    await seedEvent({ id: "firefly", promoterId: "p-tiverton" });
    const { fetchPage } = fetcherFrom({ [ORGANIZER]: CANCELLED_PAGE, [DMO]: CANCELLED_PAGE });
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(r.thirdPartyCaughtUp).toBe(1);
    expect(r.thirdPartyStillLive).toBe(0);
  });

  it("no organizer hit → the listing is NOT fetched (staleness is only measurable against a known answer)", async () => {
    await seedPromoter("p-tiverton", ORGANIZER);
    await seedEvent({ id: "firefly", promoterId: "p-tiverton" });
    const { fetchPage, calls } = fetcherFrom({ [ORGANIZER]: LIVE_PAGE, [DMO]: LIVE_PAGE });
    const r = await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(calls).toEqual([ORGANIZER]);
    expect(r.thirdPartyStillLive + r.thirdPartyCaughtUp).toBe(0);
  });

  it("still NEVER modifies the event row", async () => {
    await seedPromoter("p-tiverton", ORGANIZER);
    await seedEvent({ id: "firefly", promoterId: "p-tiverton" });
    const before = await db.select().from(events).where(eq(events.id, "firefly"));
    const { fetchPage } = fetcherFrom({ [ORGANIZER]: CANCELLED_PAGE, [DMO]: LIVE_PAGE });
    await runCancellationRecheck(db, { now: NOW, fetchPage });
    expect(await db.select().from(events).where(eq(events.id, "firefly"))).toEqual(before);
    expect(await db.select().from(eventDiscrepancies)).toHaveLength(1);
  });
});
