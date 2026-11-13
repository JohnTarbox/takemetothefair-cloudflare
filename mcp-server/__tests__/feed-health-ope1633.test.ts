/**
 * OPE-1633 — feed health flags: freshness, volume drop, format drift and
 * inclusion swing, opened by a read that trips them and cleared by a later
 * read back within bounds. Measure and flag only.
 *
 * Pure checks first, then the acceptance fixtures end to end through the real
 * `runFeedRead` / `pollDueFeeds` on the real 0413 + 0416 DDL (setup-db loads
 * them from the migration files). Every fetch is a fake.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  evaluateFreshness,
  evaluateReadHealth,
  fillCounts,
  isTransportFailure,
  type ReadSample,
} from "../src/feeds/health.js";
import { runFeedRead } from "../src/feeds/run.js";
import { pollDueFeeds } from "../src/feeds/schedule.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import { readOperatorQueues, totalWaiting } from "../src/operator-queue-notice.js";
import { feedLaneDigestLine, loadFeedLaneMetrics } from "@takemetothefair/db-schema";
import { publicEventWhere } from "../src/helpers.js";

const H = 3_600_000;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

const ok = (o: Partial<ReadSample> = {}): ReadSample => ({
  outcome: "ok",
  itemsRead: 10,
  included: 10,
  titleFilled: 10,
  startFilled: 10,
  venueFilled: 10,
  unmappable: 0,
  httpStatus: 200,
  error: null,
  ...o,
});
const byCheck = (rs: ReturnType<typeof evaluateReadHealth>, c: string) =>
  rs.find((r) => r.check === c);

// ── Pure checks ──────────────────────────────────────────────────────────────

describe("volume_drop", () => {
  it("trips under 50% of the median of the last 8 good reads", () => {
    const base = [ok({ itemsRead: 13 }), ok({ itemsRead: 12 }), ok({ itemsRead: 13 })];
    const r = byCheck(evaluateReadHealth(ok({ itemsRead: 6, included: 6 }), base), "volume_drop")!;
    expect(r).toMatchObject({ tripped: true, observed: 6, baseline: 13 });
    // exactly half is not under half
    expect(
      byCheck(
        evaluateReadHealth(ok({ itemsRead: 7, included: 7 }), [ok({ itemsRead: 14 })]),
        "volume_drop"
      )!.tripped
    ).toBe(false);
  });

  it("trips on 0 items after any of the last 4 reads was > 0, even with a 0 median", () => {
    // median of [0,0,0,0,0,3] is 0, so only the zero-after-some rule can catch it
    const base = [0, 0, 3, 0, 0, 0].map((n) => ok({ itemsRead: n, included: n }));
    const r = byCheck(evaluateReadHealth(ok({ itemsRead: 0, included: 0 }), base), "volume_drop")!;
    expect(r.tripped).toBe(true);
    expect(r.detail).toContain("0 items");
  });

  it("a seasonal feed that has only ever read 0 never trips", () => {
    const base = Array.from({ length: 8 }, () => ok({ itemsRead: 0, included: 0 }));
    const rs = evaluateReadHealth(ok({ itemsRead: 0, included: 0 }), base);
    expect(rs.filter((r) => r.tripped)).toEqual([]);
    expect(byCheck(rs, "volume_drop")).toMatchObject({ tripped: false, baseline: 0 });
  });

  it("only the newest 8 good reads are the baseline; 304 / error rows are ignored", () => {
    const old = Array.from({ length: 10 }, () => ok({ itemsRead: 100 }));
    const recent = Array.from({ length: 8 }, () => ok({ itemsRead: 10 }));
    const noise: ReadSample[] = [
      { ...ok(), outcome: "not_modified", itemsRead: 0 },
      { ...ok(), outcome: "error", itemsRead: 0 },
    ];
    const r = byCheck(
      evaluateReadHealth(ok({ itemsRead: 10 }), [...noise, ...recent, ...old]),
      "volume_drop"
    )!;
    expect(r).toMatchObject({ tripped: false, baseline: 10 });
  });

  it("no baseline → not evaluated (neither a trip nor a clear)", () => {
    expect(byCheck(evaluateReadHealth(ok({ itemsRead: 0 }), []), "volume_drop")).toBeUndefined();
  });
});

describe("format_drift", () => {
  it("(a) a read that fails to parse trips; an HTTP status or a timeout does not evaluate", () => {
    const parse = evaluateReadHealth(
      {
        ...ok(),
        outcome: "error",
        httpStatus: null,
        error: `Unexpected token '<', "<html>" is not valid JSON`,
      },
      []
    );
    expect(byCheck(parse, "format_drift")).toMatchObject({ tripped: true });
    expect(
      evaluateReadHealth({ ...ok(), outcome: "error", httpStatus: 503, error: "HTTP 503" }, [])
    ).toEqual([]);
    expect(
      evaluateReadHealth(
        { ...ok(), outcome: "error", httpStatus: null, error: "feed HTTP 500 on page 1" },
        []
      )
    ).toEqual([]);
    expect(
      evaluateReadHealth(
        {
          ...ok(),
          outcome: "error",
          httpStatus: null,
          error: "The operation was aborted due to timeout",
        },
        []
      )
    ).toEqual([]);
  });

  it("isTransportFailure: network-shaped messages are transport, parse-shaped are not", () => {
    expect(isTransportFailure("fetch failed", null)).toBe(true);
    expect(isTransportFailure("getaddrinfo ENOTFOUND owlshead.org", null)).toBe(true);
    expect(isTransportFailure("not an iCalendar document (content-type text/html)", null)).toBe(
      false
    );
    expect(isTransportFailure("Unexpected token '<'", null)).toBe(false);
  });

  it("(c) a key field's fill share > 30 points under its baseline trips", () => {
    const base = Array.from({ length: 4 }, () => ok());
    const r = byCheck(evaluateReadHealth(ok({ venueFilled: 5 }), base), "format_drift")!;
    expect(r).toMatchObject({ tripped: true, observed: 0.5, baseline: 1 });
    expect(r.detail).toContain("venue filled on 50%");
    // 30 points exactly is within bounds
    expect(byCheck(evaluateReadHealth(ok({ titleFilled: 7 }), base), "format_drift")!.tripped).toBe(
      false
    );
  });

  it("(b) more unmappable items than the feed's own baseline max trips; its usual skip does not", () => {
    const base = [ok({ unmappable: 1 }), ok({ unmappable: 1 }), ok({ unmappable: 0 })];
    expect(byCheck(evaluateReadHealth(ok({ unmappable: 1 }), base), "format_drift")!.tripped).toBe(
      false
    );
    expect(byCheck(evaluateReadHealth(ok({ unmappable: 4 }), base), "format_drift")!.tripped).toBe(
      true
    );
  });

  it("a clean parse with a baseline evaluates drift as within bounds (so an (a) flag clears)", () => {
    expect(byCheck(evaluateReadHealth(ok(), [ok()]), "format_drift")).toMatchObject({
      tripped: false,
    });
  });
});

describe("inclusion_swing", () => {
  it("trips when the share dropped by rules rises > 30 points over baseline", () => {
    const base = Array.from({ length: 5 }, () => ok({ itemsRead: 10, included: 9 })); // 10% dropped
    const r = byCheck(
      evaluateReadHealth(ok({ itemsRead: 10, included: 5 }), base),
      "inclusion_swing"
    )!;
    expect(r).toMatchObject({ tripped: true, observed: 0.5, baseline: 0.1 });
    expect(
      byCheck(evaluateReadHealth(ok({ itemsRead: 10, included: 6 }), base), "inclusion_swing")!
        .tripped
    ).toBe(false); // exactly 30 points
  });

  it("a 0-item read does not evaluate it", () => {
    expect(
      byCheck(evaluateReadHealth(ok({ itemsRead: 0, included: 0 }), [ok()]), "inclusion_swing")
    ).toBeUndefined();
  });
});

describe("freshness", () => {
  const now = new Date("2026-11-11T20:00:00Z");
  it("trips past 2 × poll_interval_hours since the last good read", () => {
    expect(
      evaluateFreshness(
        {
          lastOkAt: new Date(now.getTime() - 13 * H),
          createdAt: new Date(0),
          pollIntervalHours: 6,
        },
        now
      )
    ).toMatchObject({ tripped: true, baseline: 12 });
    expect(
      evaluateFreshness(
        {
          lastOkAt: new Date(now.getTime() - 11 * H),
          createdAt: new Date(0),
          pollIntervalHours: 6,
        },
        now
      ).tripped
    ).toBe(false);
  });
  it("a never-read feed ages from registration", () => {
    const r = evaluateFreshness(
      { lastOkAt: null, createdAt: new Date(now.getTime() - 30 * H), pollIntervalHours: 6 },
      now
    );
    expect(r.tripped).toBe(true);
    expect(r.detail).toContain("never read successfully");
  });
});

it("fillCounts counts non-empty title, a start date and a venue", () => {
  expect(
    fillCounts([
      { title: "A", startDate: "2027-01-01", venue: { name: "x" } },
      { title: "  ", startDate: null, venue: null },
      { title: "B", startDate: "2027-01-02", venue: null },
    ])
  ).toEqual({ titleFilled: 2, startFilled: 2, venueFilled: 1 });
});

// ── End to end ───────────────────────────────────────────────────────────────

const T0 = new Date("2026-11-11T15:00:00Z");
const GURLEY = "f-gurley";
const OHTM_TEC = "f-ohtm-tec";
const SEASONAL = "f-seasonal";

function ics(n: number): string {
  let body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n";
  for (let i = 0; i < n; i++) {
    const d = String(i + 1).padStart(2, "0");
    body += [
      "BEGIN:VEVENT",
      `DTSTART;TZID=America/New_York:202704${d}T090000`,
      `DTEND;TZID=America/New_York:202704${d}T150000`,
      "DTSTAMP:20261101T141151Z",
      `UID:show-${i}`,
      `SUMMARY:Antique Show ${i}`,
      "LOCATION:Bath Middle School\\, Bath\\, ME",
      "END:VEVENT",
      "",
    ].join("\r\n");
  }
  return body + "END:VCALENDAR\r\n";
}

interface World {
  db: TestDb;
  raw: Database.Database;
  server: CapturingMcpServer;
  items: Map<string, number>;
  tecHtml: { on: boolean };
  fetchImpl: typeof fetch;
}

function world(): World {
  const { db, raw } = createTestDb();
  const items = new Map<string, number>([
    ["gurley", 13],
    ["seasonal", 0],
  ]);
  const tecHtml = { on: false };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("owlshead.org/wp-json")) {
      if (tecHtml.on)
        return new Response("<html><body>Maintenance</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      return new Response(JSON.stringify({ events: [], next_rest_url: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const key = url.includes("gurley") ? "gurley" : "seasonal";
    // no etag: every read is a full 200, so every read is evaluated
    return new Response(ics(items.get(key) ?? 0), {
      status: 200,
      headers: { "content-type": "text/calendar" },
    });
  }) as typeof fetch;

  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug) VALUES ('p-g','Gurley Antique Shows','gurley'), ('p-o','Owls Head Transportation Museum','ohtm'), ('p-s','Skowhegan State Fair','skowhegan')"
    )
    .run();
  const ts = secs(T0);
  const feed = raw.prepare(
    `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  );
  feed.run(GURLEY, "p-g", "https://gurleyantiqueshows.com/?ical=1", "ical", ts, ts);
  feed.run(
    OHTM_TEC,
    "p-o",
    "https://owlshead.org/wp-json/tribe/events/v1/events",
    "tec_rest",
    ts,
    ts
  );
  feed.run(SEASONAL, "p-s", "https://skowheganstatefair.com/?ical=1", "ical", ts, ts);

  const server = new CapturingMcpServer();
  registerOrganizerFeedTools(server as never, db, { userId: "u-admin", role: "ADMIN" } as never, {
    fetchImpl,
    now: () => T0,
  });
  return { db, raw, server, items, tecHtml, fetchImpl };
}

const read = (w: World, feedId: string, hoursAfter: number) =>
  runFeedRead(w.db as never, {
    feedId,
    now: new Date(T0.getTime() + hoursAfter * H),
    dryRun: false,
    actor: "test",
    fetchImpl: w.fetchImpl,
    trigger: "schedule",
  });

const flags = (w: World, feedId?: string) =>
  w.raw
    .prepare(
      `SELECT check_name, observed, baseline, cleared_at, first_seen_at FROM feed_health_flags ${feedId ? "WHERE feed_id = ?" : ""} ORDER BY first_seen_at, check_name`
    )
    .all(...(feedId ? [feedId] : [])) as Array<{
    check_name: string;
    observed: number | null;
    baseline: number | null;
    cleared_at: number | null;
  }>;
const openFlags = (w: World, feedId?: string) =>
  flags(w, feedId).filter((f) => f.cleared_at === null);

describe("acceptance: Gurley returns 0 items once", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("opens a volume flag, then clears it on the next normal read", async () => {
    for (let i = 0; i < 3; i++) expect((await read(w, GURLEY, i * 7)).outcome).toBe("ingested");
    expect(openFlags(w, GURLEY)).toEqual([]);
    // fill counts are on the run log — tomorrow's baseline
    const logged = w.raw
      .prepare(
        "SELECT items_read, title_filled, start_filled, venue_filled, unmappable FROM promoter_feed_reads WHERE feed_id = ? ORDER BY started_at DESC LIMIT 1"
      )
      .get(GURLEY);
    expect(logged).toEqual({
      items_read: 13,
      title_filled: 13,
      start_filled: 13,
      venue_filled: 13,
      unmappable: 0,
    });

    w.items.set("gurley", 0);
    const zero = await read(w, GURLEY, 21);
    expect(zero.health?.opened).toContain("volume_drop");
    expect(openFlags(w, GURLEY)).toEqual([
      expect.objectContaining({ check_name: "volume_drop", observed: 0, baseline: 13 }),
    ]);

    // the flag shows on list_promoter_feeds, the digest line and the digest gate
    const listed = JSON.parse(
      ((await w.server.invoke("list_promoter_feeds", {})) as { content: Array<{ text: string }> })
        .content[0].text
    );
    const g = listed.feeds.find((f: { id: string }) => f.id === GURLEY);
    expect(g.open_flags).toEqual([expect.objectContaining({ check: "volume_drop", observed: 0 })]);
    expect(listed.feeds.find((f: { id: string }) => f.id === SEASONAL).open_flags).toEqual([]);
    const m = await loadFeedLaneMetrics(w.db as never, {
      now: new Date(T0.getTime() + 22 * H),
      publicWhere: publicEventWhere(),
    });
    expect(feedLaneDigestLine(m)).toContain(
      "1 health flag open (Gurley Antique Shows: volume_drop)"
    );
    const q = await readOperatorQueues(w.db as never, new Date(T0.getTime() + 22 * H), {});
    expect(q.openFeedHealthFlags).toBe(1);
    expect(totalWaiting({ ...q, openFeedHealthFlags: undefined as never })).toBe(
      totalWaiting(q) - 1
    );

    w.items.set("gurley", 13);
    const back = await read(w, GURLEY, 28);
    expect(back.health?.cleared).toContain("volume_drop");
    expect(openFlags(w, GURLEY)).toEqual([]);
    // the cleared row stays as history
    expect(flags(w, GURLEY)).toHaveLength(1);
  });

  it("a second 0 read refreshes the one open row (no duplicate)", async () => {
    for (let i = 0; i < 2; i++) await read(w, GURLEY, i * 7);
    w.items.set("gurley", 0);
    await read(w, GURLEY, 14);
    const second = await read(w, GURLEY, 21);
    expect(second.health?.opened).toEqual([]);
    expect(openFlags(w, GURLEY).filter((f) => f.check_name === "volume_drop")).toHaveLength(1);
  });
});

describe("acceptance: OHTM's TEC REST returns HTML", () => {
  it("opens a format-drift flag", async () => {
    const w = world();
    w.tecHtml.on = true;
    const r = await read(w, OHTM_TEC, 0);
    expect(r.outcome).toBe("error");
    expect(r.health?.opened).toEqual(["format_drift"]);
    expect(openFlags(w, OHTM_TEC)).toEqual([
      expect.objectContaining({ check_name: "format_drift" }),
    ]);
    // and a good parse afterwards clears it
    w.tecHtml.on = false;
    await read(w, OHTM_TEC, 7);
    const back = await read(w, OHTM_TEC, 14);
    expect(back.health?.cleared).toContain("format_drift");
    expect(openFlags(w, OHTM_TEC)).toEqual([]);
  });
});

describe("a seasonal feed that has only ever read 0", () => {
  it("never flags", async () => {
    const w = world();
    for (let i = 0; i < 10; i++) expect((await read(w, SEASONAL, i * 7)).outcome).toBe("ingested");
    expect(flags(w, SEASONAL)).toEqual([]);
  });
});

describe("freshness, from the hourly poll", () => {
  it("flags every enabled feed past 2× its interval — read or not — and clears after a good read", async () => {
    const w = world();
    const now = new Date(T0.getTime() + 30 * H);
    // Gurley read OK 13h before `now`; nothing is due (next_read_at in the future).
    w.raw
      .prepare("UPDATE promoter_event_feeds SET last_ok_at = ?, next_read_at = ?")
      .run(secs(new Date(now.getTime() - 13 * H)), secs(new Date(now.getTime() + 5 * H)));
    w.raw.prepare("UPDATE promoter_event_feeds SET enabled = 0 WHERE id = ?").run(SEASONAL);
    const s = await pollDueFeeds(w.db as never, { now, enabled: true, fetchImpl: w.fetchImpl });
    expect(s.due).toBe(0);
    expect(s.health).toEqual({ evaluated: 2, stale: 2, open: 2 });
    expect(openFlags(w).map((f) => f.check_name)).toEqual(["freshness", "freshness"]);
    // a disabled feed is not evaluated
    expect(flags(w, SEASONAL)).toEqual([]);

    // Gurley comes due and reads OK → its freshness clears in the same pass
    w.raw
      .prepare("UPDATE promoter_event_feeds SET next_read_at = ? WHERE id = ?")
      .run(secs(now), GURLEY);
    const s2 = await pollDueFeeds(w.db as never, { now, enabled: true, fetchImpl: w.fetchImpl });
    expect(s2.ingested).toBe(1);
    expect(s2.health).toEqual({ evaluated: 2, stale: 1, open: 1 });
    expect(openFlags(w, GURLEY)).toEqual([]);
  });

  it("the pinged pass and polling-off do not evaluate", async () => {
    const w = world();
    const now = new Date(T0.getTime() + 30 * H);
    expect(
      (
        await pollDueFeeds(w.db as never, {
          now,
          enabled: true,
          onlyPinged: true,
          fetchImpl: w.fetchImpl,
        })
      ).health
    ).toBeUndefined();
    expect((await pollDueFeeds(w.db as never, { now, enabled: false })).health).toBeUndefined();
    expect(flags(w)).toEqual([]);
  });
});

it("a dry run writes no flag", async () => {
  const w = world();
  w.tecHtml.on = true;
  const r = await runFeedRead(w.db as never, {
    feedId: OHTM_TEC,
    now: T0,
    dryRun: true,
    actor: "test",
    fetchImpl: w.fetchImpl,
  });
  expect(r.outcome).toBe("error");
  expect(r.health).toBeUndefined();
  expect(flags(w)).toEqual([]);
});
