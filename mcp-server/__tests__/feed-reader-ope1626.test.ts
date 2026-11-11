/**
 * OPE-1626 — the scheduled feed reader: scheduled read == manual read, 304,
 * auto-disable + fault row, questions_hold, TENTATIVE counts as published,
 * the run log, list/set tools, WebSub's second flag, the digest line, and no
 * email from the reader.
 *
 * Real 0406 + 0409 + 0412 + 0413 DDL (setup-db loads them from the migration
 * files). Nothing touches the network: every fetch is a fake.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import { pollDueFeeds } from "../src/feeds/schedule.js";
import {
  FEED_AUTO_DISABLE_AFTER,
  FEED_READ_FAILED_FAULT,
  FEED_READ_FAILED_SOURCE,
  FEED_READ_LOG_KEEP,
  runFeedRead,
} from "../src/feeds/run.js";
import {
  ensureWebSubSubscription,
  isWebSubEnabled,
  renewWebSubLeases,
} from "../src/feeds/websub.js";
import {
  checkOperatorQueues,
  readOperatorQueues,
  totalWaiting,
} from "../src/operator-queue-notice.js";

const T0 = new Date("2026-11-11T15:00:00Z");
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const OHTM_FEED_ID = "0b555459-a15f-48b5-9c6f-7fa9bd2cd182";
const FEED_URL = "https://owlshead.org/?ical=1&eventDisplay=list";
const HUB = "https://hub.example.net/";
const ADMIN = { userId: "u-admin", role: "ADMIN" as const };

const vevent = (o: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  desc?: string;
  url?: string;
}) =>
  [
    "BEGIN:VEVENT",
    `DTSTART;TZID=America/New_York:${o.start}`,
    `DTEND;TZID=America/New_York:${o.end}`,
    "DTSTAMP:20261101T141151Z",
    `UID:${o.uid}`,
    `SUMMARY:${o.summary}`,
    `DESCRIPTION:${o.desc ?? "A museum event."}`,
    `URL:${o.url ?? `https://owlshead.org/event/${o.uid}/`}`,
    "LOCATION:Owls Head Transportation Museum\\, 117 Museum St.\\, Owls Head\\, ME\\, 04854\\, United States",
    'ORGANIZER;CN="Events":MAILTO:events@ohtm.org',
    "END:VEVENT",
    "",
  ].join("\r\n");

/** One APPROVED event the feed contradicts, one TENTATIVE one, one new show. */
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nX-WR-CALNAME:OHTM\r\n" +
  vevent({
    uid: "jr-inventors",
    summary: "Junior Inventors",
    start: "20270319T043000",
    end: "20270319T063000",
    desc: "Jr. Inventor program runs 4:30-6:30 PM.",
    url: "https://owlshead.org/event/junior-inventors/",
  }) +
  vevent({
    uid: "harvest",
    summary: "Harvest Gathering",
    start: "20270501T100000",
    end: "20270501T140000",
    url: "https://owlshead.org/event/harvest/",
  }) +
  vevent({
    uid: "truck-show",
    summary: "Antique Truck Show",
    start: "20270605T090000",
    end: "20270605T150000",
  }) +
  "END:VCALENDAR\r\n";

interface World {
  db: TestDb;
  raw: Database.Database;
  server: CapturingMcpServer;
  fetchLog: Array<{ url: string; inm: string | null; method: string }>;
  setRespond: (fn: ((url: string) => Response | null) | null) => void;
  setClock: (d: Date) => void;
  fetchImpl: typeof fetch;
}

function world(): World {
  const { db, raw } = createTestDb();
  let clock = T0;
  let respond: ((url: string) => Response | null) | null = null;
  const fetchLog: World["fetchLog"] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchLog.push({ url, inm: headers.get("if-none-match"), method: init?.method ?? "GET" });
    const custom = respond?.(url);
    if (custom) return custom;
    if (headers.get("if-none-match") === '"v1"')
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    return new Response(ICS, {
      status: 200,
      headers: { "content-type": "text/calendar", etag: '"v1"' },
    });
  }) as typeof fetch;

  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','Owls Head Transportation Museum','ohtm','https://owlshead.org')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO venues (id, name, slug, city, state) VALUES ('v1','Owls Head Transportation Museum','ohtm-venue','Owls Head','ME')"
    )
    .run();
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12) / 1000;
  const ins = raw.prepare(
    "INSERT INTO events (id, name, slug, promoter_id, venue_id, start_date, end_date, status, source_url) VALUES (?,?,?,'p1','v1',?,?,?,?)"
  );
  ins.run(
    "e-ac",
    "Junior Inventors",
    "junior-inventors",
    day(2027, 3, 19),
    day(2027, 3, 19),
    "APPROVED",
    "https://owlshead.org/event/junior-inventors/"
  );
  ins.run(
    "e-tent",
    "Harvest Gathering",
    "harvest-gathering",
    day(2027, 5, 1),
    day(2027, 5, 1),
    "TENTATIVE",
    "https://owlshead.org/event/harvest/"
  );
  raw
    .prepare(
      "INSERT INTO event_days (id, event_id, date, open_time, close_time) VALUES ('d-ac','e-ac','2027-03-19','04:30','06:30'), ('d-tent','e-tent','2027-05-01','09:00','14:00')"
    )
    .run();
  const ts = secs(T0);
  raw
    .prepare(
      "INSERT INTO promoter_contacts (id, promoter_id, name, email, validation_method, status, first_validated_at, last_heard_at, created_at, updated_at) VALUES ('c1','p1','Sammi','events@ohtm.org','domain_verified','validated',?,?,?,?)"
    )
    .run(ts, ts, ts, ts);
  // Registered directly (ownership is OPE-1617's test), never read, due now.
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
       VALUES (?, 'p1', ?, 'ical', 1, ?, ?)`
    )
    .run(OHTM_FEED_ID, FEED_URL, ts, ts);

  const server = new CapturingMcpServer();
  registerOrganizerFeedTools(server as never, db, ADMIN as never, {
    fetchImpl,
    now: () => clock,
  });
  return {
    db,
    raw,
    server,
    fetchLog,
    fetchImpl,
    setRespond: (fn) => {
      respond = fn;
    },
    setClock: (d) => {
      clock = d;
    },
  };
}

type Result = { content: Array<{ text: string }>; isError?: boolean };
async function call(w: World, name: string, args: Record<string, unknown>) {
  const r = (await w.server.invoke(name, args)) as Result;
  return {
    isError: !!r.isError,
    text: r.content[0].text,
    body: r.isError ? null : JSON.parse(r.content[0].text),
  };
}
const q = <T = Record<string, unknown>>(w: World, sql: string, ...p: unknown[]) =>
  w.raw.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(w: World, sql: string, ...p: unknown[]) =>
  w.raw.prepare(sql).get(...p) as T;
const feedRow = (w: World) =>
  one<{
    enabled: number;
    consecutive_errors: number;
    next_read_at: number | null;
    last_ok_at: number | null;
    last_read_status: string | null;
    disabled_reason: string | null;
    disabled_at: number | null;
    questions_hold: number;
  }>(w, "SELECT * FROM promoter_event_feeds WHERE id = ?", OHTM_FEED_ID);
const runs = (w: World) =>
  q<Record<string, unknown>>(
    w,
    "SELECT triggered_by, outcome, http_status, items_read, included, linked, awaiting_review, discrepancies, third_values, error FROM promoter_feed_reads ORDER BY started_at, rowid"
  );
const sentNothing = (w: World) => {
  expect(one(w, "SELECT count(*) AS n FROM email_send_ledger")).toEqual({ n: 0 });
  expect(one(w, "SELECT count(*) AS n FROM operator_outbound_drafts")).toEqual({ n: 0 });
  expect(one(w, "SELECT count(*) AS n FROM feed_discrepancy_batches")).toEqual({ n: 0 });
};
/** What a read left behind, minus row ids and the trigger. */
const snapshot = (w: World) => ({
  items: q(
    w,
    "SELECT external_id, event_id, review_state, included, content_hash, start_local FROM promoter_feed_items ORDER BY external_id"
  ),
  discrepancies: q<{ event_id: string; divergent_value: string; notes: string }>(
    w,
    "SELECT event_id, divergent_value, notes, resolution_status FROM event_discrepancies ORDER BY event_id, divergent_value"
  ),
  feed: q(
    w,
    "SELECT enabled, consecutive_errors, next_read_at, last_ok_at, last_read_status, http_etag FROM promoter_event_feeds"
  ),
  run: runs(w).map(({ triggered_by: _t, ...rest }) => rest),
});

let w: World;
beforeEach(() => {
  w = world();
});

describe("the scheduled pass reads a due feed on its own", () => {
  it("a due feed is read with no manual call, and leaves exactly what a manual read leaves", async () => {
    // positive landmark: registered, never read, nothing in the tables
    expect(feedRow(w)).toMatchObject({ last_ok_at: null, next_read_at: null });
    expect(q(w, "SELECT id FROM promoter_feed_items")).toHaveLength(0);

    const s = await pollDueFeeds(w.db as never, {
      now: T0,
      enabled: true,
      fetchImpl: w.fetchImpl,
    });
    expect(s).toMatchObject({ due: 1, ingested: 1, errors: 0, feed_ids: [OHTM_FEED_ID] });
    const scheduled = snapshot(w);
    expect(runs(w)).toEqual([
      expect.objectContaining({ triggered_by: "schedule", outcome: "ok", http_status: 200 }),
    ]);

    // The same snapshot through ingest_promoter_feed(dry_run:false) on a fresh db.
    const m = world();
    const r = await call(m, "ingest_promoter_feed", { feed_id: OHTM_FEED_ID, dry_run: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.outcome).toBe("ingested");
    const manual = snapshot(m);
    expect(runs(m)[0]).toMatchObject({ triggered_by: "manual" });
    expect(scheduled).toEqual(manual);

    // and the shape itself: 3 items read, the show awaits review, 2 linked
    expect(scheduled.run).toEqual([
      {
        outcome: "ok",
        http_status: 200,
        items_read: 3,
        included: 2, // "Junior Inventors" is a program; the show and the gathering stay
        linked: 2,
        awaiting_review: 1,
        discrepancies: 2,
        third_values: 0,
        error: null,
      },
    ]);
    expect(scheduled.items.find((i) => i.external_id === "truck-show")).toMatchObject({
      review_state: "awaiting_review",
      event_id: null,
    });
    expect(scheduled.feed[0]).toMatchObject({
      consecutive_errors: 0,
      last_ok_at: secs(T0),
      next_read_at: secs(T0) + 6 * 3600,
    });
    sentNothing(w);
  });

  it("TENTATIVE counts as published: its contradicted time opens a discrepancy", async () => {
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    const rows = q<{ event_id: string; divergent_value: string; notes: string }>(
      w,
      "SELECT event_id, divergent_value, notes FROM event_discrepancies WHERE detected_by='organizer_feed' AND resolution_status='open' ORDER BY event_id"
    );
    expect(rows.map((r) => [r.event_id, JSON.parse(r.notes).kind, r.divergent_value])).toEqual([
      ["e-ac", "am_pm_slip", "04:30"],
      ["e-tent", "feed_differs", "10:00"],
    ]);
    // and the dry-run report says so too
    const r = await call(w, "ingest_promoter_feed", { feed_id: OHTM_FEED_ID, dry_run: true });
    const tent = r.body.items.find((i: { external_id: string }) => i.external_id === "harvest");
    expect(tent).toMatchObject({ event_id: "e-tent", published: true });
  });

  it("a CANCELLED lifecycle or a REJECTED row is not published (the public gate, both halves)", async () => {
    w.raw.prepare("UPDATE events SET lifecycle_status='CANCELLED' WHERE id='e-tent'").run();
    w.raw.prepare("UPDATE events SET status='REJECTED' WHERE id='e-ac'").run();
    const r = await call(w, "ingest_promoter_feed", { feed_id: OHTM_FEED_ID, dry_run: true });
    const pub = Object.fromEntries(
      r.body.items.map((i: { external_id: string; published: boolean }) => [
        i.external_id,
        i.published,
      ])
    );
    expect(pub).toEqual({ "jr-inventors": false, harvest: false, "truck-show": false });
  });
});

describe("304 Not Modified", () => {
  it("does no ingest work, counts as success and resets the error streak", async () => {
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    const before = snapshot(w);
    const ingestedRows = q(w, "SELECT id FROM admin_actions WHERE action='feed.ingested'").length;
    w.raw.prepare("UPDATE promoter_event_feeds SET consecutive_errors = 2").run();

    const t1 = new Date(T0.getTime() + 7 * 3_600_000);
    const s = await pollDueFeeds(w.db as never, { now: t1, enabled: true, fetchImpl: w.fetchImpl });
    expect(s).toMatchObject({ due: 1, not_modified: 1, ingested: 0, errors: 0 });
    expect(w.fetchLog.at(-1)!.inm).toBe('"v1"');
    // no ingest: items, discrepancies, feed.ingested untouched
    const after = snapshot(w);
    expect(after.items).toEqual(before.items);
    expect(after.discrepancies).toEqual(before.discrepancies);
    expect(q(w, "SELECT id FROM admin_actions WHERE action='feed.ingested'")).toHaveLength(
      ingestedRows
    );
    expect(feedRow(w)).toMatchObject({
      consecutive_errors: 0,
      last_ok_at: secs(t1),
      last_read_status: "not modified (304)",
    });
    expect(runs(w).at(-1)).toMatchObject({
      outcome: "not_modified",
      http_status: 304,
      items_read: 0,
    });
  });
});

describe("auto-disable after repeated failures", () => {
  it(`${FEED_AUTO_DISABLE_AFTER} consecutive failures switch the feed off and write one fault row`, async () => {
    w.setRespond(() => new Response("down", { status: 503 }));
    let t = T0;
    for (let i = 1; i <= FEED_AUTO_DISABLE_AFTER; i++) {
      const s = await pollDueFeeds(w.db as never, {
        now: t,
        enabled: true,
        fetchImpl: w.fetchImpl,
      });
      expect(s.errors, `round ${i}`).toBe(1);
      const f = feedRow(w);
      expect(f.consecutive_errors).toBe(i);
      if (i < FEED_AUTO_DISABLE_AFTER) {
        // landmark: still on, no fault yet
        expect(f.enabled).toBe(1);
        expect(q(w, "SELECT id FROM error_logs WHERE source = ?", FEED_READ_FAILED_SOURCE)).toEqual(
          []
        );
      }
      t = new Date(f.next_read_at! * 1000);
    }
    const f = feedRow(w);
    expect(f.enabled).toBe(0);
    expect(f.disabled_reason).toMatch(
      /^auto-disabled after 5 consecutive failed reads; last: HTTP 503/
    );
    expect(f.disabled_at).not.toBeNull();
    const faults = q<{ level: string; message: string }>(
      w,
      "SELECT level, message FROM error_logs WHERE source = ?",
      FEED_READ_FAILED_SOURCE
    );
    expect(faults).toHaveLength(1);
    expect(faults[0].level).toBe("error");
    expect(faults[0].message.startsWith(FEED_READ_FAILED_FAULT)).toBe(true);
    expect(runs(w).map((r) => [r.outcome, r.http_status])).toEqual(
      Array.from({ length: 5 }, () => ["error", 503])
    );

    // A disabled feed is not due, and is never fetched — even far later.
    const fetches = w.fetchLog.length;
    const later = await pollDueFeeds(w.db as never, {
      now: new Date(t.getTime() + 30 * 86_400_000),
      enabled: true,
      fetchImpl: w.fetchImpl,
    });
    expect(later.due).toBe(0);
    expect(w.fetchLog).toHaveLength(fetches);
    // A direct read of a disabled feed is skipped (and logged as such), not fetched.
    const direct = await runFeedRead(w.db as never, {
      feedId: OHTM_FEED_ID,
      now: t,
      dryRun: false,
      actor: "test",
      fetchImpl: w.fetchImpl,
      trigger: "ping",
    });
    expect(direct.outcome).toBe("skipped");
    expect(w.fetchLog).toHaveLength(fetches);
    expect(runs(w).at(-1)).toMatchObject({ outcome: "skipped", triggered_by: "ping" });
  });

  it("a good read resets the streak before it reaches the limit", async () => {
    w.raw
      .prepare("UPDATE promoter_event_feeds SET consecutive_errors = ?")
      .run(FEED_AUTO_DISABLE_AFTER - 1);
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    expect(feedRow(w)).toMatchObject({ enabled: 1, consecutive_errors: 0, disabled_reason: null });
  });
});

describe("questions_hold", () => {
  it("the 0413 migration holds the OHTM feed", () => {
    // The harness created the table empty, so the migration's UPDATE matched
    // nothing; replay it now that the OHTM row exists.
    const sql = readFileSync(join(__dirname, "../../drizzle/0413_ope1626_feed_reader.sql"), "utf8");
    const stmt = /UPDATE promoter_event_feeds SET questions_hold = 1 WHERE id = '[^']+';/.exec(sql);
    expect(stmt).not.toBeNull();
    expect(feedRow(w).questions_hold).toBe(0);
    w.raw["exec"](stmt![0]);
    expect(feedRow(w).questions_hold).toBe(1);
  });

  it("while held, reads open discrepancies but no batch or draft is composed; clearing it allows the next", async () => {
    w.raw.prepare("UPDATE promoter_event_feeds SET questions_hold = 1").run();
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    expect(
      q(w, "SELECT id FROM event_discrepancies WHERE resolution_status='open'").length
    ).toBeGreaterThan(0);

    for (const dry_run of [false, true]) {
      const r = await call(w, "compose_feed_discrepancy_batch", { promoter_id: "p1", dry_run });
      expect(r.body.composed, `dry_run ${dry_run}`).toBe(false);
      expect(r.body.reason).toMatch(/questions_hold is set/);
    }
    sentNothing(w);

    const cleared = await call(w, "set_promoter_feed", {
      feed_id: OHTM_FEED_ID,
      questions_hold: false,
    });
    expect(cleared.isError, cleared.text).toBe(false);
    expect(cleared.body.after.questions_hold).toBe(false);
    const r = await call(w, "compose_feed_discrepancy_batch", {
      promoter_id: "p1",
      dry_run: false,
    });
    expect(r.body).toMatchObject({ composed: true, questions: 2, to: "events@ohtm.org" });
    expect(one(w, "SELECT status FROM operator_outbound_drafts")).toEqual({ status: "pending" });
    // composed as a draft — still nothing sent
    expect(one(w, "SELECT count(*) AS n FROM email_send_ledger")).toEqual({ n: 0 });
  });

  it("the reader itself never composes, held or not", async () => {
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    await pollDueFeeds(w.db as never, {
      now: new Date(T0.getTime() + 7 * 3_600_000),
      enabled: true,
      fetchImpl: w.fetchImpl,
    });
    expect(q(w, "SELECT id FROM event_discrepancies").length).toBeGreaterThan(0);
    sentNothing(w);
  });
});

describe("run log", () => {
  it(`keeps the newest ${FEED_READ_LOG_KEEP} rows per feed`, async () => {
    const ins = w.raw.prepare(
      "INSERT INTO promoter_feed_reads (id, feed_id, started_at, triggered_by, outcome) VALUES (?, ?, ?, 'schedule', 'ok')"
    );
    for (let i = 0; i < FEED_READ_LOG_KEEP + 5; i++)
      ins.run(`old-${i}`, OHTM_FEED_ID, secs(T0) - 100_000 + i);
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    const rows = q<{ id: string }>(
      w,
      "SELECT id FROM promoter_feed_reads WHERE feed_id = ? ORDER BY started_at DESC",
      OHTM_FEED_ID
    );
    expect(rows).toHaveLength(FEED_READ_LOG_KEEP);
    expect(rows[0].id).not.toMatch(/^old-/); // the new read is kept
    expect(rows.some((r) => r.id === "old-0")).toBe(false); // the oldest went
  });
});

describe("list_promoter_feeds / set_promoter_feed", () => {
  it("lists the reader's state with the last run's counts", async () => {
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });
    const r = await call(w, "list_promoter_feeds", {});
    expect(r.isError, r.text).toBe(false);
    expect(r.body.feeds).toHaveLength(1);
    expect(r.body.feeds[0]).toMatchObject({
      id: OHTM_FEED_ID,
      promoter: "Owls Head Transportation Museum",
      url: FEED_URL,
      kind: "ical",
      enabled: true,
      disabled_reason: null,
      questions_hold: false,
      poll_interval_hours: 6,
      last_ok_at: T0.toISOString(),
      next_read_at: new Date(T0.getTime() + 6 * 3_600_000).toISOString(),
      consecutive_errors: 0,
      last_run: {
        trigger: "schedule",
        outcome: "ok",
        items_read: 3,
        awaiting_review: 1,
        discrepancies: 2,
      },
    });
    expect((await call(w, "list_promoter_feeds", { promoter_id: "nope" })).body.feeds).toEqual([]);
  });

  it("validates its input and audit-logs every change", async () => {
    expect((await call(w, "set_promoter_feed", { feed_id: OHTM_FEED_ID })).isError).toBe(true);
    for (const h of [0, 169, 2.5]) {
      const r = await call(w, "set_promoter_feed", {
        feed_id: OHTM_FEED_ID,
        poll_interval_hours: h,
      });
      expect(r.isError, `poll_interval_hours ${h}`).toBe(true);
    }
    expect((await call(w, "set_promoter_feed", { feed_id: "nope", enabled: false })).isError).toBe(
      true
    );

    const off = await call(w, "set_promoter_feed", {
      feed_id: OHTM_FEED_ID,
      enabled: false,
      reason: "site rebuild",
      poll_interval_hours: 12,
    });
    expect(off.isError, off.text).toBe(false);
    expect(feedRow(w)).toMatchObject({ enabled: 0, disabled_reason: "operator: site rebuild" });

    w.raw
      .prepare("UPDATE promoter_event_feeds SET consecutive_errors = 5, next_read_at = ?")
      .run(secs(T0) + 86_400);
    const on = await call(w, "set_promoter_feed", { feed_id: OHTM_FEED_ID, enabled: true });
    expect(on.isError, on.text).toBe(false);
    expect(feedRow(w)).toMatchObject({
      enabled: 1,
      disabled_reason: null,
      disabled_at: null,
      consecutive_errors: 0,
      next_read_at: null,
    });
    const audit = q<{ action: string; target_id: string; payload_json: string }>(
      w,
      "SELECT action, target_id, payload_json FROM admin_actions WHERE action='feed.settings_changed' ORDER BY created_at, rowid"
    );
    expect(audit).toHaveLength(2);
    expect(audit[0].target_id).toBe(OHTM_FEED_ID);
    expect(JSON.parse(audit[0].payload_json)).toMatchObject({
      before: { enabled: true, poll_interval_hours: 6 },
      after: { enabled: false, poll_interval_hours: 12 },
    });
  });

  it("is admin-only", () => {
    const s = new CapturingMcpServer();
    registerOrganizerFeedTools(s as never, w.db, { userId: "u", role: "USER" } as never);
    expect(() => s.invoke("list_promoter_feeds", {})).toThrow();
  });
});

describe("WebSub needs WEBSUB_ENABLED as well as polling", () => {
  const hubFeed = (url: string) =>
    url === HUB
      ? new Response(null, { status: 202 })
      : new Response(ICS, { headers: { link: `<${HUB}>; rel="hub"`, etag: '"v2"' } });

  it("polling on, WebSub off: the feed is read and no hub is contacted", async () => {
    w.setRespond(hubFeed);
    for (const flags of [
      undefined,
      { FEED_POLLING_ENABLED: "true", WEBSUB_ENABLED: "false" },
      { FEED_POLLING_ENABLED: "true" },
      { FEED_POLLING_ENABLED: "false", WEBSUB_ENABLED: "true" },
    ]) {
      w.raw.prepare("UPDATE promoter_event_feeds SET next_read_at = NULL").run();
      const s = await pollDueFeeds(w.db as never, {
        now: T0,
        enabled: true,
        fetchImpl: w.fetchImpl,
        websubFlags: flags,
      });
      expect(s.ingested + s.not_modified, JSON.stringify(flags)).toBe(1);
    }
    expect(w.fetchLog.filter((c) => c.url === HUB)).toEqual([]);
    expect(q(w, "SELECT id FROM feed_websub_subscriptions")).toEqual([]);

    // positive landmark: with both flags the same read does subscribe
    w.raw.prepare("UPDATE promoter_event_feeds SET next_read_at = NULL").run();
    await pollDueFeeds(w.db as never, {
      now: T0,
      enabled: true,
      fetchImpl: w.fetchImpl,
      websubFlags: { FEED_POLLING_ENABLED: "true", WEBSUB_ENABLED: "true" },
    });
    expect(w.fetchLog.filter((c) => c.url === HUB)).toHaveLength(1);
  });

  it("websub.ts refuses on its own, whatever the caller", async () => {
    expect(isWebSubEnabled({ FEED_POLLING_ENABLED: "true", WEBSUB_ENABLED: "true" })).toBe(true);
    expect(isWebSubEnabled({ FEED_POLLING_ENABLED: "true", WEBSUB_ENABLED: "false" })).toBe(false);
    expect(isWebSubEnabled(null)).toBe(false);
    expect(
      await ensureWebSubSubscription(w.db as never, {
        feedId: OHTM_FEED_ID,
        links: { hub: HUB, topic: FEED_URL },
        now: T0,
        fetchImpl: w.fetchImpl,
        flags: { FEED_POLLING_ENABLED: "true", WEBSUB_ENABLED: "false" },
      })
    ).toBe("disabled");
    // an active lease about to run out is NOT renewed while WebSub is off
    w.raw
      .prepare(
        `INSERT INTO feed_websub_subscriptions (id, feed_id, hub_url, topic_url, secret, state, lease_expires_at, created_at, updated_at)
         VALUES ('s1', ?, ?, ?, 'k', 'active', ?, ?, ?)`
      )
      .run(OHTM_FEED_ID, HUB, FEED_URL, secs(T0) + 60, secs(T0), secs(T0));
    expect(
      await renewWebSubLeases(w.db as never, {
        now: T0,
        fetchImpl: w.fetchImpl,
        flags: { FEED_POLLING_ENABLED: "true" },
      })
    ).toEqual({ renewed: 0, errors: 0 });
    expect(w.fetchLog).toEqual([]);
  });

  it("wrangler.toml ships polling ON and WebSub OFF", () => {
    const toml = readFileSync(join(__dirname, "../wrangler.toml"), "utf8");
    expect(toml).toMatch(/^FEED_POLLING_ENABLED = "true"$/m);
    expect(toml).toMatch(/^WEBSUB_ENABLED = "false"$/m);
  });
});

describe("new feed events reach the daily operator digest", () => {
  it("counts upcoming awaiting_review items of enabled feeds, and the line is in the mail", async () => {
    // landmark: before any read, nothing to say about feeds
    expect((await readOperatorQueues(w.db as never, T0, {})).feedItemsAwaitingReview).toBe(0);
    await pollDueFeeds(w.db as never, { now: T0, enabled: true, fetchImpl: w.fetchImpl });

    const c = await readOperatorQueues(w.db as never, T0, {});
    expect(c.feedItemsAwaitingReview).toBe(1);
    expect(c.lines.join("\n")).toContain("1 new organizer-feed event(s) awaiting review");
    expect(totalWaiting(c)).toBeGreaterThanOrEqual(1);
    expect(totalWaiting({ ...c, feedItemsAwaitingReview: undefined as never })).toBe(
      totalWaiting(c) - 1
    );

    const sent: Array<{ text: string; source: string }> = [];
    await checkOperatorQueues(
      w.db as never,
      {
        ALERT_EMAIL_TECHNICAL: "ops@example.com",
        EMAIL_JOBS: { send: async (m: { text: string; source: string }) => void sent.push(m) },
      } as never,
      T0
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].source).toBe("operator-queue-notice");
    expect(sent[0].text).toContain("new organizer-feed event(s) awaiting review");

    // a past item, or one on a disabled feed, is not counted
    w.raw.prepare("UPDATE promoter_feed_items SET start_local = '2026-01-01 09:00'").run();
    expect((await readOperatorQueues(w.db as never, T0, {})).feedItemsAwaitingReview).toBe(0);
    w.raw.prepare("UPDATE promoter_feed_items SET start_local = '2027-06-05 09:00'").run();
    w.raw.prepare("UPDATE promoter_event_feeds SET enabled = 0").run();
    expect((await readOperatorQueues(w.db as never, T0, {})).feedItemsAwaitingReview).toBe(0);
  });
});
