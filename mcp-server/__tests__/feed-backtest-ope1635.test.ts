/**
 * OPE-1635 — feed analytics 4/5: safe rule changes, on the real 0406…0440 DDL
 * (setup-db loads 0440 from the migration file):
 *   - the ingest keeps each DISTINCT item version (history), capped per item;
 *   - the replay corpus reads explicit labels AND pre-OPE-1634 review decisions;
 *   - backtest_feed_rules replays OPE-1629 over real 11-11 reads ingested here;
 *   - the change log: 0440's backfilled OPE-1629 row, record → follow-up fill,
 *     the probe helper's clock, and the read through get_feed_lane_metrics.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { ingestFeedItems } from "../src/feeds/ingest.js";
import { mapTecEvent } from "../src/feeds/tec.js";
import { badPattern, registerFeedBacktestTools } from "../src/tools/admin-feed-backtest.js";
import {
  FEED_ITEM_SNAPSHOT_KEEP,
  fillDueRuleChangeFollowups,
  impliedLabel,
  listFeedRuleChanges,
  loadReplayCorpus,
  oldestOwedRuleChangeFollowup,
  recordFeedItemSnapshot,
  runFeedBacktest,
} from "@takemetothefair/db-schema/feed-backtest";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import { recordFeedItemLabel } from "@takemetothefair/db-schema/feed-quality";
import type { FeedEvent } from "@takemetothefair/utils/feeds";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
let db: TestDb;
let raw: Database.Database;
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).get(...p) as T;

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../packages/utils/src/__tests__/fixtures/ope1629-tec-feeds-2026-11-11.json"
    ),
    "utf8"
  )
) as { feeds: Record<string, Array<Record<string, unknown>>> };
const tec = (feed: string) => FIXTURE.feeds[feed].map((r) => mapTecEvent(r)!) as FeedEvent[];

const read = (feedId: string, items: FeedEvent[], at = "2026-11-26T12:00:00Z") =>
  ingestFeedItems(db as never, { feedId, items, now: new Date(at), dryRun: false, actor: "test" });

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug) VALUES ('p-m','Marshfield Fair','marshfield-fair'), ('p-o','Owls Head Transportation Museum','ohtm')"
    )
    .run();
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
       VALUES ('f-m','p-m','https://marshfield.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1),
              ('f-o','p-o','https://ohtm.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1)`
    )
    .run();
});

// ── history ─────────────────────────────────────────────────────────────────

describe("replay corpus history — the ingest keeps each distinct version", () => {
  it("a new item writes one history row; an unchanged re-read writes none; a change writes one more", async () => {
    const [first] = tec("marsh");
    await read("f-m", [first]);
    const n = () =>
      one<{ n: number }>("SELECT COUNT(*) n FROM promoter_feed_item_snapshots").n as number;
    expect(n()).toBe(1);
    await read("f-m", [first], "2026-11-26T18:00:00Z");
    expect(n()).toBe(1);
    await read("f-m", [{ ...first, startTime: "09:00" }], "2026-11-27T00:00:00Z");
    expect(n()).toBe(2);
    // Both rows belong to the one item, and the newest equals the item's snapshot.
    const rows = q<{ feed_item_id: string; snapshot: string }>(
      "SELECT feed_item_id, snapshot FROM promoter_feed_item_snapshots ORDER BY captured_at DESC"
    );
    const item = one<{ id: string; snapshot: string }>(
      "SELECT id, snapshot FROM promoter_feed_items"
    );
    expect(new Set(rows.map((r) => r.feed_item_id))).toEqual(new Set([item.id]));
    expect(rows[0].snapshot).toBe(item.snapshot);
  });

  it(`keeps only the newest ${FEED_ITEM_SNAPSHOT_KEEP} versions of an item`, async () => {
    const [first] = tec("marsh");
    await read("f-m", [first]);
    const item = one<{ id: string }>("SELECT id FROM promoter_feed_items");
    for (let i = 0; i < FEED_ITEM_SNAPSHOT_KEEP + 3; i++) {
      await recordFeedItemSnapshot(db as never, {
        feedItemId: item.id,
        feedId: "f-m",
        contentHash: `h${i}`,
        snapshot: JSON.stringify({ ...first, startTime: `1${i % 10}:00` }),
        now: new Date(Date.UTC(2026, 11, 1 + i)),
      });
    }
    const kept = q<{ content_hash: string }>(
      "SELECT content_hash FROM promoter_feed_item_snapshots ORDER BY captured_at"
    );
    expect(kept).toHaveLength(FEED_ITEM_SNAPSHOT_KEEP);
    // The oldest were pruned: the ingest's own first version and h0..h2.
    expect(kept[0].content_hash).toBe("h3");
  });

  it("0440 seeds history from every item's current snapshot (re-run on a pre-0440 row)", () => {
    raw
      .prepare(
        `INSERT INTO promoter_feed_items (id, feed_id, external_id, title, included, review_state, content_hash, snapshot, first_seen_at, last_seen_at)
         VALUES ('pre','f-m','x','Old row',1,'awaiting_review','hx','{"title":"Old row"}',1,2)`
      )
      .run();
    raw.prepare("DELETE FROM promoter_feed_item_snapshots").run();
    const sql = readFileSync(
      join(__dirname, "../../drizzle/0440_ope1635_feed_replay_corpus.sql"),
      "utf8"
    );
    raw["exec"](sql.slice(0, sql.indexOf("INSERT INTO heartbeat_probes")));
    const h = one<{ content_hash: string; captured_at: number }>(
      "SELECT content_hash, captured_at FROM promoter_feed_item_snapshots WHERE feed_item_id='pre'"
    );
    expect(h).toEqual({ content_hash: "hx", captured_at: 2 });
    // Re-applying is a no-op (INSERT OR IGNORE on the hash; the change-log row too).
    raw["exec"](sql.slice(0, sql.indexOf("INSERT INTO heartbeat_probes")));
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM promoter_feed_item_snapshots").n).toBe(1);
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM feed_rule_changes").n).toBe(1);
  });
});

// ── corpus labels ───────────────────────────────────────────────────────────

describe("replay corpus labels — explicit rows plus pre-OPE-1634 reviews", () => {
  it("impliedLabel reads a reject, an approve and a reviewer link off the item", () => {
    expect(impliedLabel({ reviewState: "rejected", linkBasis: null })).toBe("rejected");
    expect(impliedLabel({ reviewState: "linked", linkBasis: "review_approve" })).toBe("approved");
    expect(impliedLabel({ reviewState: "linked", linkBasis: "review_link" })).toBe("missed_match");
    // An automatic link is not a human decision.
    expect(impliedLabel({ reviewState: "linked", linkBasis: "source_url" })).toBeNull();
    expect(impliedLabel({ reviewState: "awaiting_review", linkBasis: null })).toBeNull();
  });

  it("counts both kinds, and a later explicit label overrides the implied one", async () => {
    await read("f-o", tec("ohtm"));
    const [a, b] = q<{ id: string }>(
      "SELECT id FROM promoter_feed_items WHERE feed_id='f-o' ORDER BY external_id LIMIT 2"
    );
    raw
      .prepare(
        "UPDATE promoter_feed_items SET review_state='rejected', reviewed_at=? WHERE id IN (?, ?)"
      )
      .run(Date.parse("2026-11-12T00:00:00Z") / 1000, a.id, b.id);
    await recordFeedItemLabel(db as never, {
      feedItemId: b.id,
      feedId: "f-o",
      label: "approved",
      reason: null,
      included: true,
      source: "review",
      actor: "test",
      note: null,
      sampleId: null,
      at: new Date("2026-11-26T00:00:00Z"),
    });
    const c = await loadReplayCorpus(db as never);
    expect(c.labels).toEqual({ explicit: 1, implied: 2 });
    const byId = new Map(c.inclusion.map((i) => [i.itemId, i]));
    const { labelExpectation } = await import("@takemetothefair/utils/feeds");
    expect(labelExpectation(byId.get(a.id)!.labels)).toBe("drop");
    expect(labelExpectation(byId.get(b.id)!.labels)).toBe("keep");
  });
});

// ── the tool ────────────────────────────────────────────────────────────────

type Result = { content: Array<{ text: string }>; isError?: boolean };
describe("backtest_feed_rules", () => {
  let server: CapturingMcpServer;
  const call = async (args: Record<string, unknown>) => {
    const r = (await server.invoke("backtest_feed_rules", args)) as Result;
    return {
      isError: !!r.isError,
      text: r.content[0].text,
      body: r.isError ? null : JSON.parse(r.content[0].text),
    };
  };
  beforeEach(async () => {
    server = new CapturingMcpServer();
    registerFeedBacktestTools(server as never, db, ADMIN, {
      now: () => new Date("2026-11-26T20:00:00Z"),
    });
    await read("f-m", tec("marsh"));
    await read("f-o", tec("ohtm"));
  });

  it("ACCEPTANCE 1 — replaying OPE-1629 moves Marshfield's 7 markets to included; OHTM's STEM programs stay dropped", async () => {
    const r = await call({ baseline_preset: "pre_ope1629" });
    expect(r.isError).toBe(false);
    // Positive landmark: the whole corpus was replayed.
    expect(r.body.corpus.items).toBe(27);
    expect(r.body.inclusion.to_included.count).toBe(7);
    expect(
      r.body.inclusion.to_included.items.every((f: { feed_id: string }) => f.feed_id === "f-m")
    ).toBe(true);
    expect(r.body.inclusion.to_dropped.count).toBe(0);
    expect(r.body.inclusion.wrong_way.count).toBe(0);
    const stem = q<{ id: string }>(
      "SELECT id FROM promoter_feed_items WHERE feed_id='f-o' AND title LIKE '%STEM%'"
    );
    expect(stem.length).toBeGreaterThanOrEqual(3);
    const flipped = new Set(
      r.body.inclusion.to_included.items.map((f: { item_id: string }) => f.item_id)
    );
    for (const s of stem) expect(flipped.has(s.id)).toBe(false);
    expect(r.body.summary_markdown).toMatch(/^## Backtest/);
  });

  it("flags a wrong-way flip against a review decision, first", async () => {
    // A reviewer approved one of Marshfield's markets (pre-OPE-1634: implied label).
    raw
      .prepare(
        "UPDATE promoter_feed_items SET link_basis='review_approve', review_state='linked' WHERE id=(SELECT id FROM promoter_feed_items WHERE feed_id='f-m' LIMIT 1)"
      )
      .run();
    const r = await call({ proposed_rules: { excludeTitlePatterns: ["\\bmarket\\b"] } });
    expect(r.body.inclusion.to_dropped.count).toBe(7);
    expect(r.body.inclusion.wrong_way.count).toBe(1);
    expect(r.body.inclusion.wrong_way.items[0].expected).toBe("keep");
    expect(r.body.summary_markdown).toContain("WRONG-WAY");
    expect(r.body.corpus.labels.implied).toBe(1);
  });

  it("is read-only: nothing changes in the items or the history", async () => {
    const before = q("SELECT * FROM promoter_feed_items ORDER BY id");
    const hist = q("SELECT * FROM promoter_feed_item_snapshots ORDER BY id");
    await call({ proposed_rules: { defaultInclude: false }, include_history: true });
    expect(q("SELECT * FROM promoter_feed_items ORDER BY id")).toEqual(before);
    expect(q("SELECT * FROM promoter_feed_item_snapshots ORDER BY id")).toEqual(hist);
  });

  it("a pattern that does not compile is an error, not a silent no-op", async () => {
    const r = await call({ proposed_rules: { excludeTitlePatterns: ["(unclosed"] } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not compile/);
    expect(badPattern({ includeTitlePatterns: ["ok", "[x"] })).toMatch(/includeTitlePatterns/);
    expect(badPattern(undefined)).toBeNull();
  });

  it("replays the matcher: a looser name-key length gains a short-titled item's match", async () => {
    // The minimum gates the ITEM's name key: "Rally" (5) never matches at the
    // default 6, so its listing on the same date is found only at 3.
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status) VALUES ('e-rally', 'Fall Rally', 'fall-rally', 'p-m', ?, ?, 'APPROVED')"
      )
      .run(Date.parse("2026-12-05T15:00:00Z") / 1000, Date.parse("2026-12-05T19:00:00Z") / 1000);
    const [m0] = tec("marsh");
    await read("f-m", [
      {
        ...m0,
        externalId: "rally-1",
        title: "Rally",
        url: null,
        startDate: "2026-12-05",
        endDate: "2026-12-05",
      },
    ]);
    const item = one<{ id: string; event_id: string | null }>(
      "SELECT id, event_id FROM promoter_feed_items WHERE external_id='rally-1'"
    );
    expect(item.event_id).toBeNull(); // the live ingest (default 6) did not link it
    const same = await call({});
    expect(same.body.matcher.gained.count).toBe(0);
    const r = await runFeedBacktest(db as never, { proposedMatcher: { minNameKeyLength: 3 } });
    expect(r.matcher.examined.items).toBe(28);
    expect(r.matcher.gained.count).toBe(1);
    expect(r.matcher.gained.items[0]).toMatchObject({
      item_id: item.id,
      before: null,
      after: "e-rally",
    });
    expect(r.matcher.lost.count).toBe(0);
  });
});

// ── change log ──────────────────────────────────────────────────────────────

describe("feed rule change log", () => {
  it("0440 carries the backfilled OPE-1629 entry, honest about its missing 'before'", async () => {
    const [row] = await listFeedRuleChanges(db as never);
    expect(row).toMatchObject({ id: "ope1629-pr1780", pr: `#${1780}`, ope_id: "OPE-1629" });
    expect(row.changed_at).toBe("2026-11-12T15:20:50.000Z");
    expect(row.metrics_before).toBeNull();
    expect(row.metrics_before_note).toMatch(/Backfilled/);
    expect(row.backtest).toMatch(/8 dropped -> included/);
  });

  it("the probe clock for a backfilled row starts when it was inserted, not at its past due date", async () => {
    const now = new Date();
    const owed = await oldestOwedRuleChangeFollowup(db as never, now);
    expect(owed).not.toBeNull();
    // Due 11-19, inserted at harness creation (now): the clock is the insert time.
    expect(owed!.getTime()).toBeGreaterThan(Date.parse("2026-11-20T00:00:00Z"));
  });

  it("record → the cron fills 'after' once 7 days pass, once; the metrics tool reads it", async () => {
    const server = new CapturingMcpServer();
    registerFeedBacktestTools(server as never, db, ADMIN, {
      now: () => new Date("2026-12-01T12:00:00Z"),
    });
    const r = (await server.invoke("record_feed_rule_change", {
      kind: "inclusion",
      pr: `#${90017}`,
      ope_id: "OPE-90017",
      summary: "test change",
      backtest: "## Backtest\n0 flips",
      changed_at: "2026-12-01T10:00:00Z",
    })) as Result;
    const body = JSON.parse(r.content[0].text);
    expect(body.after_due_at).toBe("2026-12-08T10:00:00.000Z");
    const row = one<{ metrics_before: string; metrics_after: string | null }>(
      "SELECT metrics_before, metrics_after FROM feed_rule_changes WHERE id=?",
      body.id
    );
    expect(JSON.parse(row.metrics_before)).toHaveProperty("labels");
    expect(row.metrics_after).toBeNull();

    // Before due: only the backfilled 1629 row is owed.
    expect(await fillDueRuleChangeFollowups(db as never, new Date("2026-12-05T00:00:00Z"))).toBe(1);
    expect(await fillDueRuleChangeFollowups(db as never, new Date("2026-12-05T01:00:00Z"))).toBe(0);
    // After due: this one, once.
    expect(await fillDueRuleChangeFollowups(db as never, new Date("2026-12-08T11:00:00Z"))).toBe(1);
    expect(await fillDueRuleChangeFollowups(db as never, new Date("2026-12-08T12:00:00Z"))).toBe(0);
    expect(
      await oldestOwedRuleChangeFollowup(db as never, new Date("2026-12-09T00:00:00Z"))
    ).toBeNull();

    // Read through the SHIPPED path: the get_feed_lane_metrics tool.
    const ms = new CapturingMcpServer();
    registerOrganizerFeedTools(ms as never, db, ADMIN as never, {
      now: () => new Date("2026-12-09T00:00:00Z"),
    });
    const mr = (await ms.invoke("get_feed_lane_metrics", {})) as Result;
    const m = JSON.parse(mr.content[0].text) as {
      rule_changes: Array<{ ope_id: string; metrics_after: unknown }>;
    };
    expect(m.rule_changes.map((c) => c.ope_id)).toEqual(["OPE-90017", "OPE-1629"]);
    expect(m.rule_changes[0].metrics_after).toHaveProperty("labels");
  });

  it("refuses a change dated in the future", async () => {
    const server = new CapturingMcpServer();
    registerFeedBacktestTools(server as never, db, ADMIN, {
      now: () => new Date("2026-12-01T12:00:00Z"),
    });
    const r = (await server.invoke("record_feed_rule_change", {
      kind: "matcher",
      summary: "x",
      changed_at: "2026-12-03T00:00:00Z",
    })) as Result;
    expect(r.isError).toBe(true);
  });
});
