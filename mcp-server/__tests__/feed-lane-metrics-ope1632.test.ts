/**
 * OPE-1632 — `get_feed_lane_metrics` over the real feed DDL (setup-db loads the
 * migrations). Proves the loader's SQL: the public gate on "published", the
 * coverage read, the discrepancy join, and the promoter filter. The arithmetic
 * itself is covered in packages/db-schema/src/feed-lane-metrics.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import { readOperatorQueues } from "../src/operator-queue-notice.js";

const NOW = new Date("2026-11-11T19:00:00Z");
const READ = new Date("2026-11-11T14:20:00Z");
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const ADMIN = { userId: "u-admin", role: "ADMIN" as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed tool JSON, asserted field by field
type Json = Record<string, any>;

function setup() {
  const { db, raw }: TestDb = createTestDb();
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')").run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug) VALUES ('p-saco','Saco Main Street','saco'), ('p-gur','Gurley Antique Shows','gurley'), ('p-none','No Feed Promoter','none')"
    )
    .run();
  const ev = raw.prepare(
    "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, lifecycle_status) VALUES (?,?,?,?,?,?,?,?)"
  );
  const dec1 = secs(new Date("2026-12-01T00:00:00Z"));
  ev.run(
    "e-pub",
    "Saco Holiday Market",
    "saco-holiday",
    "p-saco",
    dec1,
    dec1,
    "APPROVED",
    "SCHEDULED"
  );
  ev.run("e-pend", "Saco Kids Day", "saco-kids", "p-saco", dec1, dec1, "PENDING", "SCHEDULED");
  ev.run("e-other", "Unrelated Fair", "unrelated", "p-none", dec1, dec1, "APPROVED", "SCHEDULED");
  ev.run(
    "e-past",
    "Old Fair",
    "old",
    "p-saco",
    secs(new Date("2026-10-01T00:00:00Z")),
    secs(new Date("2026-10-01T00:00:00Z")),
    "APPROVED",
    "SCHEDULED"
  );

  const feed = raw.prepare(
    "INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, last_ok_at, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)"
  );
  feed.run(
    "f-saco",
    "p-saco",
    "https://saco.example/feed",
    "tec_rest",
    secs(READ),
    secs(READ),
    secs(READ)
  );
  feed.run(
    "f-gur",
    "p-gur",
    "https://gurley.example/feed",
    "tec_rest",
    secs(READ),
    secs(READ),
    secs(READ)
  );

  const item = raw.prepare(
    "INSERT INTO promoter_feed_items (id, feed_id, external_id, event_id, title, start_local, included, exclusion_reason, review_state, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  item.run(
    "i1",
    "f-saco",
    "1",
    "e-pub",
    "Holiday Market",
    "2026-12-01",
    1,
    null,
    "linked",
    secs(READ),
    secs(READ)
  );
  item.run(
    "i2",
    "f-saco",
    "2",
    "e-pend",
    "Kids Day",
    "2026-12-01",
    0,
    "program matches /\\bkids?\\b/",
    "linked",
    secs(READ),
    secs(READ)
  );
  for (let k = 0; k < 3; k++)
    item.run(
      `g${k}`,
      "f-gur",
      `g${k}`,
      null,
      `Show ${k}`,
      "2027-01-10",
      1,
      null,
      "awaiting_review",
      secs(READ),
      secs(READ)
    );

  raw
    .prepare(
      "INSERT INTO event_discrepancies (id, event_id, field_class, detected_by, detected_at, notes) VALUES ('d1','e-pub','status','organizer_feed',?,?)"
    )
    .run(secs(READ), JSON.stringify({ field: "status", kind: "feed_cancelled" }));

  const server = new CapturingMcpServer();
  registerOrganizerFeedTools(server as never, db, ADMIN as never, { now: () => NOW });
  return { server, raw, db };
}

async function call(server: CapturingMcpServer, args: Json = {}): Promise<Json> {
  const r = (await server.invoke("get_feed_lane_metrics", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
}
const step = (sec: Json, name: string) => sec.funnel.steps.find((s: Json) => s.step === name);

describe("get_feed_lane_metrics (OPE-1632)", () => {
  let w: ReturnType<typeof setup>;
  beforeEach(() => {
    w = setup();
  });

  it("counts the funnel from D1, and 'published' follows the public gate, not the link", async () => {
    const m = await call(w.server);
    expect(step(m.total, "read").count).toBe(5);
    expect(step(m.total, "matched").count).toBe(2);
    expect(m.total.funnel.matched_outside_filter).toBe(1);
    expect(step(m.total, "new").count).toBe(3);
    // e-pend is linked but PENDING: matched, not published.
    expect(step(m.total, "published").count).toBe(1);
    // No review recorded yet: a real 0, now that the review step exists (OPE-1630).
    expect(step(m.total, "reviewed")).toMatchObject({ count: 0 });
    expect(step(m.total, "approved")).toMatchObject({ count: 0, rate: null });
  });

  it("reviewed / approved / rejected read the review step: reviewed_at + the LATEST feed_item.* action", async () => {
    const at = secs(READ) + 3600;
    w.raw
      .prepare("UPDATE promoter_feed_items SET reviewed_at=? WHERE id IN ('i1','g0','g1')")
      .run(at);
    w.raw.prepare("UPDATE promoter_feed_items SET review_state='rejected' WHERE id='g0'").run();
    const act = w.raw.prepare(
      "INSERT INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)"
    );
    // i1: an older link, then an approve — the latest action decides.
    act.run("a1", "feed_item.link", "u-admin", "promoter_feed_item", "i1", "{}", at - 60);
    act.run("a2", "feed_item.approve", "u-admin", "promoter_feed_item", "i1", "{}", at);
    act.run("a3", "feed_item.reject", "u-admin", "promoter_feed_item", "g0", "{}", at);
    // g1: linked to an existing listing — reviewed, but not an approval.
    act.run("a4", "feed_item.link", "u-admin", "promoter_feed_item", "g1", "{}", at);
    // A non-review action on the same target is ignored.
    act.run("a5", "event.merge", "u-admin", "promoter_feed_item", "g1", "{}", at + 60);

    const m = await call(w.server);
    expect(step(m.total, "reviewed")).toMatchObject({ count: 3, rate_base: "included" });
    expect(step(m.total, "approved")).toMatchObject({ count: 1, rate_base: "reviewed" });
    expect(step(m.total, "rejected")).toMatchObject({ count: 1, rate_base: "reviewed" });
  });

  it("coverage: upcoming public events only, by healthy feed and feed link", async () => {
    const m = await call(w.server);
    // e-pub and e-other are upcoming + public; e-pend is PENDING; e-past ended.
    expect(m.coverage.upcoming_public_events).toBe(2);
    expect(m.coverage.share_with_healthy_feed.value).toBe(0.5);
    expect(m.coverage.share_feed_linked.value).toBe(0.5);
    expect(m.coverage.new_to_us.value).toBe(3);
    expect(m.feeds).toMatchObject({ registered: 2, enabled: 2, healthy: 2 });
  });

  it("change capture reads the feed detector's discrepancies and their kind", async () => {
    const m = await call(w.server);
    expect(m.total.change_capture.detected.value).toBe(1);
    expect(m.total.change_capture.cancellations.value).toBe(1);
    expect(m.total.change_capture.before_event.value).toBe(1);
  });

  it("promoter_id narrows every section to that promoter", async () => {
    const m = await call(w.server, { promoter_id: "p-gur" });
    expect(m.per_feed.map((f: Json) => f.feed_id)).toEqual(["f-gur"]);
    expect(step(m.total, "read").count).toBe(3);
    expect(m.total.change_capture.detected.value).toBe(0);
    expect(m.coverage.upcoming_public_events).toBe(0);
    expect(m.coverage.share_with_healthy_feed).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
  });

  it("changes nothing", async () => {
    const before = w.raw.prepare("SELECT count(*) n FROM admin_actions").get() as { n: number };
    await call(w.server);
    const after = w.raw.prepare("SELECT count(*) n FROM admin_actions").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("the daily digest's feeds line (OPE-1632)", () => {
  it("carries one Feeds: line built from the same metrics", async () => {
    const w = setup();
    const c = await readOperatorQueues(w.db as never, NOW, {});
    const feedLines = c.lines.filter((l) => l.startsWith("Feeds: "));
    expect(feedLines).toEqual([
      "Feeds: 2 of 2 healthy, 3 awaiting review (oldest <1d), 3 new to us this week (get_feed_lane_metrics, OPE-1632).",
    ]);
  });

  it("says nothing about feeds when no feed is registered", async () => {
    const { db, raw } = createTestDb();
    raw
      .prepare("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')")
      .run();
    const c = await readOperatorQueues(db as never, NOW, {});
    // landmark: the notice did build its lines array
    expect(Array.isArray(c.lines)).toBe(true);
    expect(c.lines.some((l) => l.startsWith("Feeds: "))).toBe(false);
  });
});
