/**
 * OPE-1636 part A — feed fault families, on the real migrated DDL.
 *
 * Every family's detector is planted with ONE row that must count and at least
 * one near-miss that must not (outside the window, before the approval, the
 * wrong field/label/check, an unrelated merge), so a detector that silently
 * stops matching — or matches too much — goes red. Then the shipped read path:
 * get_feed_lane_metrics returns `fault_families` and, with retro: true, the
 * monthly retro's "Feeds" section.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import {
  FEED_FAULT_FAMILIES,
  loadFeedFaultEvents,
  loadFeedFaultFamilies,
  type FeedFaultReport,
} from "@takemetothefair/db-schema/feed-fault-families";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const NOW = new Date("2026-11-26T20:00:00Z");
const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const APPROVED_AT = "2026-11-20T12:00:00Z";

let db: TestDb;
let raw: Database.Database;
const run = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p);

type Result = { content: Array<{ text: string }> };

beforeEach(() => {
  ({ db, raw } = createTestDb());
  // The harness has no cpi_signal_filings; load the real migration (prod has it since 0149).
  raw.exec(
    readFileSync(
      join(__dirname, "../../drizzle/0149_ope76_cpi_signal_filings.sql"),
      "utf8"
    ).replace(/--> statement-breakpoint/g, "")
  );
  run("INSERT INTO users (id, email, role) VALUES ('u-admin','admin@test','ADMIN')");
  run(
    "INSERT INTO promoters (id, company_name, slug) VALUES ('p-m','Marshfield Fair','marshfield-fair')"
  );
  run(
    `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
     VALUES ('f-m','p-m','https://marshfield.example/wp-json/tribe/events/v1/events','tec_rest',1,1,1)`
  );
  run(
    `INSERT INTO promoter_feed_items (id, feed_id, external_id, first_seen_at, last_seen_at)
     VALUES ('i-1','f-m','x1',1,1), ('i-2','f-m','x2',1,1)`
  );

  // feed-fetch-failed: 2 errors in the window, 1 ok (not a fault), 1 error 100 days old.
  const read = (id: string, outcome: string, at: string) =>
    run(
      `INSERT INTO promoter_feed_reads (id, feed_id, started_at, triggered_by, outcome) VALUES (?, 'f-m', ?, 'schedule', ?)`,
      id,
      s(at),
      outcome
    );
  read("r-e1", "error", "2026-11-24T06:00:00Z");
  read("r-e2", "error", "2026-11-25T06:00:00Z");
  read("r-ok", "ok", "2026-11-25T12:00:00Z");
  read("r-old", "error", "2026-08-18T06:00:00Z");

  // feed-format-drift: one drift flag; a freshness flag is not drift.
  run(
    `INSERT INTO feed_health_flags (id, feed_id, check_name, first_seen_at, last_seen_at)
     VALUES ('h-drift','f-m','format_drift',?,?), ('h-fresh','f-m','freshness',?,?)`,
    s("2026-11-23T00:00:00Z"),
    s("2026-11-23T00:00:00Z"),
    s("2026-11-23T00:00:00Z"),
    s("2026-11-23T00:00:00Z")
  );

  // labels: one of each fault label, plus a correct_drop (not a fault).
  const label = (id: string, l: string) =>
    run(
      `INSERT INTO feed_item_labels (id, feed_item_id, feed_id, label, source, created_at) VALUES (?, 'i-1', 'f-m', ?, 'review', ?)`,
      id,
      l,
      s("2026-11-22T00:00:00Z")
    );
  label("l-fd", "false_drop");
  label("l-mm", "missed_match");
  label("l-wm", "wrong_match");
  label("l-cd", "correct_drop");

  // The approval: feed item i-1 created event e-feed at APPROVED_AT.
  run(
    `INSERT INTO admin_actions (id, action, target_type, target_id, payload_json, created_at)
     VALUES ('a-ap','feed_item.approve','promoter_feed_item','i-1',?,?)`,
    JSON.stringify({ feed_id: "f-m", event_id: "e-feed" }),
    s(APPROVED_AT)
  );
  // feed-duplicate-created: e-feed merged into e-keep AFTER the approval → counts.
  const merge = (id: string, keeper: string, dup: string, at: string) =>
    run(
      `INSERT INTO admin_actions (id, action, target_type, target_id, payload_json, created_at) VALUES (?, 'event.merge', 'event', ?, ?, ?)`,
      id,
      keeper,
      JSON.stringify({ duplicateId: dup }),
      s(at)
    );
  merge("m-after", "e-keep", "e-feed", "2026-11-24T00:00:00Z");
  merge("m-before", "e-feed", "e-other", "2026-11-19T00:00:00Z"); // before the approval
  merge("m-unrelated", "e-x", "e-y", "2026-11-24T00:00:00Z");

  // feed-wrong-venue: venue_id changed after the approval → counts; before, or another field, does not.
  const hist = (id: string, field: string, at: string) =>
    run(
      `INSERT INTO entity_field_history (id, entity_type, entity_id, field, old_value, new_value, actor, source, changed_at)
       VALUES (?, 'event', 'e-feed', ?, 'v-old', 'v-new', 'u-admin', 'mcp:update_event', ?)`,
      id,
      field,
      s(at)
    );
  hist("fh-venue", "venue_id", "2026-11-21T00:00:00Z");
  hist("fh-early", "venue_id", "2026-11-19T00:00:00Z");
  hist("fh-name", "name", "2026-11-21T00:00:00Z");
});

describe("feed fault family detectors (OPE-1636)", () => {
  it("each detector counts its planted row and none of the near-misses", async () => {
    const report = await loadFeedFaultFamilies(db as never, { now: NOW });
    const by = Object.fromEntries(report.families.map((f) => [f.id, f.count_window]));
    expect(by).toEqual({
      "feed-fetch-failed": 2,
      "feed-format-drift": 1,
      "feed-false-drop": 1,
      "feed-missed-match": 1,
      "feed-wrong-match": 1,
      "feed-duplicate-created": 1,
      "feed-wrong-venue": 1,
    });
    // Positive landmark: the 100-day-old error is outside the 8-week load, not silently dropped later.
    expect(report.occurrences_examined).toBe(8);
    // Every family in the registry is reported, with an owner lane.
    expect(report.families.map((f) => f.id)).toEqual(FEED_FAULT_FAMILIES.map((f) => f.id));
    expect(report.families.every((f) => f.owner_lane.length > 0)).toBe(true);
    // fetch-failed is the top family, but 2 is under the auto-file threshold of 3.
    expect(report.top).toEqual({ id: "feed-fetch-failed", count_window: 2, fileable: false });
  });

  it("the refs name the planted rows (the join returns the right ones, not just the right count)", async () => {
    const ev = await loadFeedFaultEvents(db as never, new Date("2026-10-01T00:00:00Z"));
    const refs = (fam: string) =>
      ev
        .filter((e) => e.family === fam)
        .map((e) => e.ref)
        .sort();
    expect(refs("feed-duplicate-created")).toEqual(["m-after"]);
    expect(refs("feed-wrong-venue")).toEqual(["fh-venue"]);
    expect(refs("feed-fetch-failed")).toEqual(["r-e1", "r-e2"]);
    // Raw SQL timestamps are seconds: a ms/s slip would put these in 1970 or 58000 AD.
    expect(ev.find((e) => e.ref === "r-e1")!.at.toISOString()).toBe("2026-11-24T06:00:00.000Z");
    expect(ev.find((e) => e.ref === "m-after")!.feedId).toBe("f-m");
  });

  it("a third error makes the top family fileable", async () => {
    run(
      `INSERT INTO promoter_feed_reads (id, feed_id, started_at, triggered_by, outcome) VALUES ('r-e3','f-m',?,'schedule','error')`,
      s("2026-11-26T06:00:00Z")
    );
    const report = await loadFeedFaultFamilies(db as never, { now: NOW });
    expect(report.top).toEqual({ id: "feed-fetch-failed", count_window: 3, fileable: true });
  });

  it("get_feed_lane_metrics returns fault_families, and retro: true adds the Feeds section", async () => {
    const ms = new CapturingMcpServer();
    registerOrganizerFeedTools(ms as never, db, ADMIN as never, { now: () => NOW });

    const plain = JSON.parse(
      ((await ms.invoke("get_feed_lane_metrics", {})) as Result).content[0].text
    ) as { fault_families: FeedFaultReport; retro_section?: string };
    expect(plain.fault_families.families).toHaveLength(7);
    expect(plain.retro_section).toBeUndefined();

    run(
      `INSERT INTO cpi_signal_filings (fingerprint, priority, title, href, last_seen_at, status, ope_id, created_at)
       VALUES ('cpi:feed:feed-fetch-failed','P1','t','/admin/feed-review',1,'filed','OPE-90001',1)`
    );
    const retro = JSON.parse(
      ((await ms.invoke("get_feed_lane_metrics", { retro: true })) as Result).content[0].text
    ) as { retro_section: string };
    const md = retro.retro_section;
    expect(md).toMatch(/^## Feeds /);
    for (const heading of [
      "**Funnel**",
      "**Quality**",
      "**Open health flags:**",
      "**Rule changes:**",
      "**Fault families**",
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("- feed-fetch-failed: 2 ");
    expect(md).toContain(
      "**Top fault family:** feed-fetch-failed (2). Prevention ticket: OPE-90001 (filed)."
    );
  });
});
