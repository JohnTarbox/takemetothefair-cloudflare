/**
 * OPE-1635 — the two probes that ship with the replay corpus and the change
 * log, driven both ways on the real 0440 DDL: healthy when nothing is owed,
 * red (an old evidence time) when the path it watches has gone silent.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../mcp-server/__tests__/setup-db";
import { HEARTBEAT_PROBES } from "../heartbeat";

let db: unknown;
let raw: Database.Database;
const probe = (name: string) => {
  const p = HEARTBEAT_PROBES.find((x) => x.name === name);
  if (!p) throw new Error(`no probe ${name}`);
  return p;
};
const HOUR = 3_600_000;
const silent = async (name: string) => {
  const p = probe(name);
  const t = await p.lastEvidenceAt(db as never);
  return t != null && Date.now() - t.getTime() > p.expectedWindowHours * HOUR;
};

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.prepare("INSERT INTO promoters (id, company_name, slug) VALUES ('p','P','p')").run();
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
       VALUES ('f','p','https://p.example/feed','tec_rest',1,1,1)`
    )
    .run();
});

const old = Math.floor((Date.now() - 48 * HOUR) / 1000);

describe("feed-item-snapshot-history (OPE-1635)", () => {
  const item = (hash: string) =>
    raw
      .prepare(
        `INSERT INTO promoter_feed_items (id, feed_id, external_id, title, included, review_state, content_hash, snapshot, first_seen_at, last_seen_at)
         VALUES ('i','f','x','T',1,'awaiting_review',?, '{"title":"T"}', ?, ?)`
      )
      .run(hash, old, old);

  it("is healthy when every item's current version has a history row", async () => {
    item("h1");
    raw
      .prepare(
        "INSERT INTO promoter_feed_item_snapshots (id, feed_item_id, feed_id, content_hash, snapshot, captured_at) VALUES ('s','i','f','h1','{}',?)"
      )
      .run(old);
    expect(await silent("feed-item-snapshot-history")).toBe(false);
  });

  it("goes red when an item was read with no history row for its current hash", async () => {
    item("h2");
    raw
      .prepare(
        "INSERT INTO promoter_feed_item_snapshots (id, feed_item_id, feed_id, content_hash, snapshot, captured_at) VALUES ('s','i','f','h1','{}',?)"
      )
      .run(old);
    expect(await silent("feed-item-snapshot-history")).toBe(true);
  });
});

describe("feed-rule-change-followup (OPE-1635)", () => {
  it("is healthy right after 0440: the backfilled OPE-1629 row's clock starts at its insert", async () => {
    // The row exists (0440 seeds it) and is past its 11-19 due date, unfilled.
    expect(
      (raw.prepare("SELECT metrics_after FROM feed_rule_changes").get() as { metrics_after: null })
        .metrics_after
    ).toBeNull();
    expect(await silent("feed-rule-change-followup")).toBe(false);
  });

  it("goes red when a change has been owed its 'after' for longer than the window", async () => {
    raw.prepare("UPDATE feed_rule_changes SET created_at = ?").run(old);
    expect(await silent("feed-rule-change-followup")).toBe(true);
    raw.prepare("UPDATE feed_rule_changes SET metrics_after = '{}', metrics_after_at = ?").run(old);
    expect(await silent("feed-rule-change-followup")).toBe(false);
  });
});
