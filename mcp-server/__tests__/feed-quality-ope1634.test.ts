/**
 * OPE-1634 — feed analytics 3/5: quality checks on our own rules.
 *
 * On the real 0406…0438 DDL (setup-db loads 0438 from the migration file):
 *   - the ingest records link_basis + inclusion_reason, never re-matches an
 *     item to the event a reviewer unlinked, and keys every feed discrepancy
 *     to the feed so a resolution scores it (organizer_feed source);
 *   - the weekly drop sample: stratification, the 2026-11-11 Marshfield
 *     BACKTEST, the idempotent builder (an empty week still writes a row);
 *   - the three MCP tools (list / record filing / label_dropped_feed_item);
 *   - 0438's backfills on rows that predate it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { ingestFeedItems } from "../src/feeds/ingest.js";
import { mapTecEvent } from "../src/feeds/tec.js";
import { registerFeedQualityTools } from "../src/tools/admin-feed-quality.js";
import { updateReliability } from "../src/goodwill/scoring.js";
import {
  buildFeedQuality,
  ensureWeeklyDropSample,
  loadDropCandidates,
  loadFeedQuality,
  renderDropSampleIssue,
  selectDropSample,
  weekStartOf,
  type DropCandidate,
} from "@takemetothefair/db-schema/feed-quality";
import {
  decideInclusion,
  DEFAULT_INCLUSION_RULES,
  inclusionRuleKey,
} from "@takemetothefair/utils/feeds";
import type { FeedEvent } from "@takemetothefair/utils/feeds";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
let db: TestDb;
let raw: Database.Database;
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
  raw.prepare(sql).get(...p) as T;
const sec = (iso: string) => Date.parse(iso) / 1000;

const ev = (o: Partial<FeedEvent>): FeedEvent => ({
  externalId: "x",
  title: "Untitled",
  url: null,
  startDate: "2026-12-13",
  endDate: "2026-12-13",
  startTime: "10:00",
  endTime: "14:00",
  allDay: false,
  timezone: "America/New_York",
  venue: {
    name: "Marshfield Fairgrounds",
    address: null,
    city: "Marshfield",
    state: "MA",
    zip: null,
  },
  organizerEmails: [],
  imageUrl: null,
  description: "",
  categories: [],
  cost: null,
  statusCancelled: false,
  ...o,
});

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
       VALUES ('f-m','p-m','https://marshfield.example/feed.ics','ical',1,1,1),
              ('f-o','p-o','https://ohtm.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1)`
    )
    .run();
});

// ── ingest ──────────────────────────────────────────────────────────────────

describe("ingest — link basis, inclusion reason, unlink memory, source key", () => {
  beforeEach(() => {
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url) VALUES ('e-mkt','Indoor Farmers Market','indoor-farmers-market-dec','p-m',?,?,'APPROVED','https://marshfield.example/e/dec')"
      )
      .run(sec("2026-12-19T15:00:00Z"), sec("2026-12-19T19:00:00Z"));
  });
  const read = (items: FeedEvent[], at = "2026-11-26T12:00:00Z") =>
    ingestFeedItems(db as never, {
      feedId: "f-m",
      items,
      now: new Date(at),
      dryRun: false,
      actor: "test",
    });
  const market = ev({
    externalId: "m-dec",
    title: "Indoor Farmers' Market",
    url: "https://marshfield.example/e/dec",
    startDate: "2026-12-19",
    endDate: "2026-12-19",
    description:
      "~20 local farmers and artisans. Always free talks, live music and kids activities.",
  });

  it("records the automatic basis and the inclusion reason of an included item", async () => {
    await read([market]);
    const row = one<{
      link_basis: string;
      inclusion_reason: string;
      exclusion_reason: string | null;
      event_id: string;
    }>(
      "SELECT link_basis, inclusion_reason, exclusion_reason, event_id FROM promoter_feed_items WHERE external_id='m-dec'"
    );
    expect(row.event_id).toBe("e-mkt");
    expect(row.link_basis).toBe("source_url");
    // Included → exclusion_reason stays NULL (existing semantics), but the reason is kept.
    expect(row.exclusion_reason).toBeNull();
    expect(row.inclusion_reason).toBe(decideInclusion(market, DEFAULT_INCLUSION_RULES).reason);
  });

  it("a later read keeps the basis the link was made with (prior)", async () => {
    await read([market]);
    raw
      .prepare("UPDATE promoter_feed_items SET link_basis='review_link' WHERE external_id='m-dec'")
      .run();
    await read([market], "2026-11-26T13:00:00Z");
    expect(
      one<{ b: string }>("SELECT link_basis b FROM promoter_feed_items WHERE external_id='m-dec'").b
    ).toBe("review_link");
  });

  it("never re-matches an item to the event a reviewer unlinked", async () => {
    await read([market]);
    // What review.ts unlink writes.
    raw
      .prepare(
        "UPDATE promoter_feed_items SET event_id=NULL, link_basis=NULL, review_state='awaiting_review', unlinked_event_id='e-mkt' WHERE external_id='m-dec'"
      )
      .run();
    await read([market], "2026-11-26T13:00:00Z");
    const row = one<{ event_id: string | null; review_state: string; link_basis: string | null }>(
      "SELECT event_id, review_state, link_basis FROM promoter_feed_items WHERE external_id='m-dec'"
    );
    expect(row).toEqual({ event_id: null, review_state: "awaiting_review", link_basis: null });
  });

  it("keys a feed discrepancy to the feed and registers it as an organizer_feed source", async () => {
    // A different start time than ours → a discrepancy on the published event.
    raw
      .prepare(
        "INSERT INTO event_days (id, event_id, date, open_time, close_time) VALUES ('d1','e-mkt','2026-12-19','10:00','14:00')"
      )
      .run();
    await read([{ ...market, startTime: "09:00" }]);
    const d = q<{ divergent_source_key: string }>(
      "SELECT divergent_source_key FROM event_discrepancies WHERE detected_by='organizer_feed'"
    );
    expect(d.length).toBeGreaterThan(0); // positive landmark: the read opened something
    expect(d.every((r) => r.divergent_source_key === "organizer_feed:f-m")).toBe(true);
    expect(
      one<{ source_type: string; display_name: string }>(
        "SELECT source_type, display_name FROM sources WHERE source_key='organizer_feed:f-m'"
      )
    ).toEqual({ source_type: "organizer_feed", display_name: "Marshfield Fair calendar feed" });
  });

  it("a resolution now scores the feed (it used to be skipped_no_source)", async () => {
    raw
      .prepare(
        "INSERT INTO event_days (id, event_id, date, open_time, close_time) VALUES ('d1','e-mkt','2026-12-19','10:00','14:00')"
      )
      .run();
    await read([{ ...market, startTime: "09:00" }]);
    const { id } = one<{ id: string }>(
      "SELECT id FROM event_discrepancies WHERE detected_by='organizer_feed' LIMIT 1"
    );
    raw
      .prepare(
        "UPDATE event_discrepancies SET resolution_status='resolved_divergent', resolution_source='promoter_reply' WHERE id=?"
      )
      .run(id);
    const r = await updateReliability(db as never, id);
    expect(r.decision).toBe("updated");
    const cell = one<{ prior_type: string; n_checks: number; n_agreed: number }>(
      "SELECT prior_type, n_checks, n_agreed FROM source_reliability WHERE source_key='organizer_feed:f-m'"
    );
    expect(cell).toEqual({ prior_type: "organizer_feed", n_checks: 1, n_agreed: 1 });
  });

  it("a dry run writes no sources row", async () => {
    await ingestFeedItems(db as never, {
      feedId: "f-m",
      items: [market],
      now: new Date("2026-11-26T12:00:00Z"),
      dryRun: true,
      actor: "test",
    });
    expect(q("SELECT 1 FROM sources WHERE source_key='organizer_feed:f-m'")).toHaveLength(0);
  });
});

// ── the sample (pure) ───────────────────────────────────────────────────────

const cand = (itemId: string, feedId: string, reason: string): DropCandidate => ({
  itemId,
  feedId,
  promoter: feedId,
  title: itemId,
  startLocal: "2026-11-12",
  url: null,
  reason,
  ruleKey: inclusionRuleKey(reason)!,
  snippet: null,
});

describe("selectDropSample", () => {
  it("takes every rule that dropped anything, then fills to 20 in proportion", () => {
    const c = [
      ...Array.from({ length: 30 }, (_, i) =>
        cand(`a${i}`, "f1", "program title matches /\\bstem\\b/")
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        cand(`b${i}`, "f1", "organizer education@x.org is excluded")
      ),
      cand("c0", "f2", "title matches closure /\\[closed\\]/"),
    ];
    const s = selectDropSample(
      c,
      [
        { feedId: "f1", total: 50, dropped: 40 },
        { feedId: "f2", total: 10, dropped: 1 },
      ],
      {
        seed: "2026-11-16",
      }
    );
    expect(s).toHaveLength(20);
    const byRule = (k: string) => s.filter((x) => x.ruleKey === k).length;
    expect(byRule("closure:\\[closed\\]")).toBe(1); // the 1-item rule is never crowded out
    expect(byRule("program_title:\\bstem\\b")).toBeGreaterThan(byRule("organizer:education@x.org"));
    expect(new Set(s.map((x) => x.itemId)).size).toBe(20);
  });

  it("the mandatory picks outrank the cap", () => {
    const c = Array.from({ length: 25 }, (_, i) =>
      cand(`r${i}`, "f1", `program title matches /rule${i}/`)
    );
    expect(selectDropSample(c, [], { seed: "w" })).toHaveLength(25);
  });

  it("always samples a feed that dropped more than half of what it carried", () => {
    const c = [
      ...Array.from({ length: 40 }, (_, i) =>
        cand(`a${i}`, "big", "program title matches /\\bjunior\\b/")
      ),
      cand("small-1", "small", "program title matches /\\bjunior\\b/"),
    ];
    const s = selectDropSample(
      c,
      [
        { feedId: "big", total: 100, dropped: 40 },
        { feedId: "small", total: 1, dropped: 1 },
      ],
      {
        seed: "w",
        max: 2,
      }
    );
    expect(s.map((x) => x.feedId)).toContain("small");
  });

  it("is reproducible for one seed", () => {
    const c = Array.from({ length: 50 }, (_, i) =>
      cand(`a${i}`, "f1", "program title matches /x/")
    );
    expect(selectDropSample(c, [], { seed: "2026-11-16" }).map((x) => x.itemId)).toEqual(
      selectDropSample(c, [], { seed: "2026-11-16" }).map((x) => x.itemId)
    );
  });

  it("weekStartOf is the UTC Monday", () => {
    expect(weekStartOf(new Date("2026-11-26T09:00:00Z"))).toBe("2026-11-23"); // Thursday
    expect(weekStartOf(new Date("2026-11-23T00:30:00Z"))).toBe("2026-11-23"); // Monday
    expect(weekStartOf(new Date("2026-11-22T23:59:00Z"))).toBe("2026-11-16"); // Sunday
  });
});

// ── the builder + the 2026-11-11 backtest ───────────────────────────────────

/**
 * The defaults as they stood BEFORE OPE-1629 (read from `git show 836998e8^`):
 * no `market` include, and a program word in the description dropped the item
 * on its own — emulated with a signal list that always matches.
 */
const PRE_1629 = {
  ...DEFAULT_INCLUSION_RULES,
  includeTitlePatterns: ["festival", "fair", "show", "airshow", "jamboree", "rally", "auction"],
  programDescriptionSignals: [".*"],
};
/** The live TEC reads of 2026-11-11 (OPE-1629's fixture). */
const FIXTURE = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../packages/utils/src/__tests__/fixtures/ope1629-tec-feeds-2026-11-11.json"
    ),
    "utf8"
  )
) as { feeds: Record<string, Record<string, unknown>[]> };

function seedItem(
  id: string,
  feedId: string,
  e: FeedEvent,
  rules = DEFAULT_INCLUSION_RULES,
  seenIso = "2026-11-11T18:00:00Z"
) {
  const v = decideInclusion(e, rules);
  raw
    .prepare(
      `INSERT INTO promoter_feed_items (id, feed_id, external_id, title, url, start_local, included, exclusion_reason, inclusion_reason, review_state, snapshot, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      feedId,
      e.externalId,
      e.title,
      e.url,
      e.startDate,
      v.included ? 1 : 0,
      v.included ? null : v.reason,
      v.reason,
      v.included ? "awaiting_review" : "dropped",
      JSON.stringify(e),
      sec(seenIso),
      sec(seenIso)
    );
  return v;
}

describe("the weekly sample — builder and the Marshfield backtest", () => {
  it("BACKTEST: the 2026-11-11 Marshfield drops appear in that week's sample", async () => {
    // The 11-11 state: the real Marshfield and OHTM reads, under the pre-1629 rules.
    const marsh = FIXTURE.feeds.marsh.map((r) => mapTecEvent(r)!);
    const ohtm = FIXTURE.feeds.ohtm.map((r) => mapTecEvent(r)!);
    expect(marsh).toHaveLength(7);
    marsh.forEach((e, k) => {
      const v = seedItem(`m${k}`, "f-m", e, PRE_1629);
      expect(v.included).toBe(false); // the precondition: these WERE drops on 11-11
    });
    let ohtmDropped = 0;
    ohtm.forEach((e, k) => {
      if (!seedItem(`o${k}`, "f-o", e, PRE_1629).included) ohtmDropped++;
    });
    // The sample for the week those drops were carried in: built Monday 11-16.
    const res = await ensureWeeklyDropSample(db as never, new Date("2026-11-16T01:00:00Z"));
    expect(res.outcome).toBe("created");
    const s = one<{ items: string; item_count: number; dropped_total: number }>(
      "SELECT items, item_count, dropped_total FROM feed_drop_samples WHERE week_start='2026-11-16'"
    );
    expect(s.dropped_total).toBe(7 + ohtmDropped); // positive landmark: every drop was a candidate
    expect(ohtmDropped).toBeGreaterThan(10);
    const items = JSON.parse(s.items) as Array<{
      feedId: string;
      ruleKey: string;
      snippet: string | null;
    }>;
    const marshfield = items.filter((i) => i.feedId === "f-m");
    expect(marshfield.length).toBeGreaterThan(0);
    expect(marshfield[0].ruleKey).toMatch(/^program_description:/);
    expect(marshfield[0].snippet).toMatch(/kids/i);
  });

  it("an empty week still writes its row, and a second call is a no-op", async () => {
    const a = await ensureWeeklyDropSample(db as never, new Date("2026-11-23T05:00:00Z"));
    const b = await ensureWeeklyDropSample(db as never, new Date("2026-11-26T05:00:00Z"));
    expect(a).toMatchObject({ outcome: "created", items: 0, week_start: "2026-11-23" });
    expect(b).toMatchObject({
      outcome: "exists",
      sample_id: (a as { sample_id: string }).sample_id,
    });
    expect(one<{ n: number }>("SELECT count(*) n FROM feed_drop_samples").n).toBe(1);
  });

  it("only items the window carried are candidates", async () => {
    seedItem(
      "old",
      "f-o",
      ev({ externalId: "old", title: "Junior Inventors – Rockets" }),
      DEFAULT_INCLUSION_RULES,
      "2026-10-01T00:00:00Z"
    );
    seedItem("new", "f-o", ev({ externalId: "new", title: "Junior Inventors – Sleds" }));
    const { candidates } = await loadDropCandidates(db as never, {
      start: new Date("2026-11-09T00:00:00Z"),
      end: new Date("2026-11-16T00:00:00Z"),
    });
    expect(candidates.map((c) => c.itemId)).toEqual(["new"]);
  });

  it("the ticket routes to the analyst and names every item and its rule", async () => {
    seedItem(
      "o1",
      "f-o",
      ev({ externalId: "o1", title: "Junior Inventors – Rockets", url: "https://ohtm.example/e/1" })
    );
    await ensureWeeklyDropSample(db as never, new Date("2026-11-16T01:00:00Z"));
    const row = one<Record<string, unknown>>("SELECT * FROM feed_drop_samples");
    const t = renderDropSampleIssue({
      id: row.id as string,
      weekStart: row.week_start as string,
      windowStart: new Date((row.window_start as number) * 1000),
      windowEnd: new Date((row.window_end as number) * 1000),
      items: row.items as string,
      droppedTotal: row.dropped_total as number,
    });
    expect(t.title).toBe(
      "[agent instructions][analyst-claude-desktop][task] Feed drop sample, week of 2026-11-16"
    );
    expect(t.body).toContain("`o1`");
    expect(t.body).toContain("program_title:\\bjunior\\b");
    expect(t.body).toContain("label_dropped_feed_item");
    expect(t.body).not.toMatch(/email|send/i);
  });
});

// ── MCP tools ───────────────────────────────────────────────────────────────

type Result = { content: Array<{ text: string }>; isError?: boolean };
describe("MCP tools", () => {
  let server: CapturingMcpServer;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await server.invoke(name, args)) as Result;
    return {
      isError: !!r.isError,
      text: r.content[0].text,
      body: r.isError ? null : JSON.parse(r.content[0].text),
    };
  };
  beforeEach(() => {
    server = new CapturingMcpServer();
    registerFeedQualityTools(server as never, db, ADMIN, {
      now: () => new Date("2026-11-16T02:00:00Z"),
    });
    seedItem("o1", "f-o", ev({ externalId: "o1", title: "Junior Inventors – Rockets" }));
  });

  it("list_feed_drop_samples build_now builds, lists it to file, and record_feed_drop_sample_filing stamps it", async () => {
    const l = await call("list_feed_drop_samples", { build_now: true });
    expect(l.body.built.outcome).toBe("created");
    expect(l.body.to_file).toHaveLength(1);
    const id = l.body.to_file[0].sample_id;
    expect(
      (await call("record_feed_drop_sample_filing", { sample_id: id, ope_id: "OPE-9001" })).body
        .changed
    ).toBe(true);
    expect((await call("list_feed_drop_samples", {})).body.to_file).toHaveLength(0);
    // Same id again: no-op. A different id: refused, never overwritten.
    expect(
      (await call("record_feed_drop_sample_filing", { sample_id: id, ope_id: "OPE-9001" })).body
        .changed
    ).toBe(false);
    const clash = await call("record_feed_drop_sample_filing", {
      sample_id: id,
      ope_id: "OPE-9002",
    });
    expect(clash.isError).toBe(true);
    expect(one<{ o: string }>("SELECT ope_id o FROM feed_drop_samples").o).toBe("OPE-9001");
  });

  it("label_dropped_feed_item records a false drop against the rule, and requires a note", async () => {
    const l = await call("list_feed_drop_samples", { build_now: true });
    const sample = l.body.to_file[0].sample_id;
    expect(
      (
        await call("label_dropped_feed_item", {
          feed_item_id: "o1",
          verdict: "should_have_been_kept",
        })
      ).isError
    ).toBe(true);
    const r = await call("label_dropped_feed_item", {
      feed_item_id: "o1",
      verdict: "should_have_been_kept",
      sample_id: sample,
      note: "a public family day",
    });
    expect(r.body.label).toBe("false_drop");
    const lab = one<Record<string, unknown>>(
      "SELECT label, rule_key, source, included, sample_id FROM feed_item_labels"
    );
    expect(lab).toEqual({
      label: "false_drop",
      rule_key: "program_title:\\bjunior\\b",
      source: "analyst",
      included: 0,
      sample_id: sample,
    });
    const qual = await loadFeedQuality(db as never, ["f-o"]);
    expect(qual.false_drops.total.value).toBe(1);
    expect(qual.false_drops.by_rule[0].rule).toBe("program_title:\\bjunior\\b");
  });

  it("refuses an item that is not in the named sample", async () => {
    const l = await call("list_feed_drop_samples", { build_now: true });
    seedItem("o2", "f-o", ev({ externalId: "o2", title: "Junior Inventors – Late" }));
    const r = await call("label_dropped_feed_item", {
      feed_item_id: "o2",
      verdict: "correct_drop",
      sample_id: l.body.to_file[0].sample_id,
    });
    expect(r.isError).toBe(true);
  });
});

// ── buildFeedQuality (pure) ─────────────────────────────────────────────────

describe("buildFeedQuality", () => {
  const at = new Date("2026-11-20T00:00:00Z");
  it("per-rule precision counts included items only; link is a positive and a matcher miss", () => {
    const q = buildFeedQuality({
      labels: [
        {
          feedId: "f",
          label: "approved",
          ruleKey: "include_title:show",
          included: true,
          linkBasis: "review_approve",
          createdAt: at,
        },
        {
          feedId: "f",
          label: "missed_match",
          ruleKey: "include_title:show",
          included: true,
          linkBasis: "review_link",
          createdAt: at,
        },
        {
          feedId: "f",
          label: "rejected",
          ruleKey: "include_title:show",
          included: true,
          linkBasis: null,
          createdAt: at,
        },
        {
          feedId: "f",
          label: "rejected",
          ruleKey: "default_exclude",
          included: false,
          linkBasis: null,
          createdAt: at,
        },
        {
          feedId: "f",
          label: "wrong_match",
          ruleKey: "include_title:show",
          included: true,
          linkBasis: "source_url",
          createdAt: at,
        },
        {
          feedId: "f",
          label: "wrong_match",
          ruleKey: "include_title:show",
          included: true,
          linkBasis: "review_link",
          createdAt: at,
        },
      ],
      items: [
        { feedId: "f", linkBasis: "source_url", eventId: "e1", firstSeenAt: at },
        { feedId: "f", linkBasis: "auto_pre_ope1634", eventId: "e2", firstSeenAt: at },
        { feedId: "f", linkBasis: "review_approve", eventId: "e3", firstSeenAt: at },
        { feedId: "f", linkBasis: null, eventId: null, firstSeenAt: at },
      ],
      discrepancies: [
        {
          resolutionStatus: "resolved_divergent",
          authoritativeValue: "10:00",
          divergentValue: "09:00",
          resolvedValue: "09:00",
        },
        {
          resolutionStatus: "resolved_authoritative",
          authoritativeValue: "10:00",
          divergentValue: "09:00",
          resolvedValue: null,
        },
        {
          resolutionStatus: "resolved_authoritative",
          authoritativeValue: "10:00",
          divergentValue: "09:00",
          resolvedValue: "11:00",
        },
        {
          resolutionStatus: "dismissed",
          authoritativeValue: null,
          divergentValue: null,
          resolvedValue: null,
        },
        {
          resolutionStatus: "superseded_by_reevaluation",
          authoritativeValue: null,
          divergentValue: null,
          resolvedValue: null,
        },
      ],
    });
    expect(q.precision_by_rule).toEqual([
      {
        rule: "include_title:show",
        approved: 2,
        rejected: 1,
        precision: expect.objectContaining({ value: 2 / 3 }),
      },
    ]);
    // 2 automatic links standing + 1 automatic link undone; the reviewer-link undo is not the matcher's.
    expect(q.matcher).toMatchObject({
      automatic_links: 3,
      wrong_automatic_links: 1,
      missed_matches: 1,
      items_seen: 4,
    });
    expect(q.matcher.wrong_match_rate.value).toBeCloseTo(1 / 3);
    expect(q.feed_vs_us).toMatchObject({
      resolved: 3,
      feed_right: 1,
      us_right: 1,
      neither: 1,
      dismissed: 1,
      open: 0,
    });
    expect(q.false_drops.total.value).toBeNull(); // no analyst label: unmeasured, not 0
  });
});

// ── 0438's backfills ────────────────────────────────────────────────────────

describe("0438 backfills (re-run on pre-existing rows)", () => {
  it("keys old feed discrepancies, takes link basis from the stored action, and never guesses an ingest basis", () => {
    const backfill = (() => {
      const sql = readFileSync(
        join(__dirname, "../../drizzle/0438_ope1634_feed_quality_labels.sql"),
        "utf8"
      );
      return sql.slice(sql.indexOf("-- Backfill:"), sql.indexOf("INSERT INTO heartbeat_probes"));
    })();
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status) VALUES ('e1','A','a','p-m',1,1,'APPROVED'), ('e2','B','b','p-m',1,1,'APPROVED')"
      )
      .run();
    raw
      .prepare(
        `INSERT INTO promoter_feed_items (id, feed_id, external_id, event_id, included, exclusion_reason, review_state, reviewed_at, first_seen_at, last_seen_at)
         VALUES ('i-rev','f-m','r','e1',1,NULL,'linked',5,1,1), ('i-auto','f-m','a','e2',1,NULL,'linked',NULL,1,1),
                ('i-drop','f-m','d',NULL,0,'default exclude','dropped',NULL,1,1)`
      )
      .run();
    raw
      .prepare(
        "INSERT INTO admin_actions (id, action, target_type, target_id, created_at) VALUES ('a1','feed_item.link','promoter_feed_item','i-rev',5)"
      )
      .run();
    raw
      .prepare(
        `INSERT INTO event_discrepancies (id, event_id, field_class, detected_by, detected_at, resolution_status, notes, created_at)
         VALUES ('d1','e2','hours','organizer_feed',1,'open','{"feed_item_external_id":"a"}',1),
                ('d2','e2','hours','organizer_feed',1,'open','not json',1)`
      )
      .run();
    raw.exec(backfill);
    expect(
      q("SELECT id, link_basis, inclusion_reason FROM promoter_feed_items ORDER BY id")
    ).toEqual([
      { id: "i-auto", link_basis: "auto_pre_ope1634", inclusion_reason: null },
      { id: "i-drop", link_basis: null, inclusion_reason: "default exclude" },
      { id: "i-rev", link_basis: "review_link", inclusion_reason: null },
    ]);
    expect(q("SELECT divergent_source_key k FROM event_discrepancies ORDER BY id")).toEqual([
      { k: "organizer_feed:f-m" },
      { k: "organizer_feed:f-m" },
    ]);
    expect(
      one<{ n: number }>(
        "SELECT count(*) n FROM source_type_priors WHERE source_type='organizer_feed'"
      ).n
    ).toBe(
      one<{ n: number }>("SELECT count(*) n FROM source_type_priors WHERE source_type='official'").n
    );
  });
});
