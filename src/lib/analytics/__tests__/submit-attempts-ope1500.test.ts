/**
 * OPE-1500 — a funnel's terminal step counts VISITORS, not attempts.
 *
 * Real-visitor register read interacted→submitted = 125% (7 days to
 * 2026-10-19): step 2 is latched to first touch, step 3 fired on every submit
 * attempt, and every excess row was a retry inside one visit (10-16 iOS: three
 * submits in 57s). The beacon now numbers attempts per mount, and the read
 * path counts only attempt 1.
 */
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import { analyticsEvents } from "../../db/schema";
import { makeSubmitAttemptTracker } from "../../analytics";
import { firstSubmitAttempt, submitRetry } from "../funnel-attempts";

describe("makeSubmitAttemptTracker", () => {
  it("numbers attempts within one mount: retries are attempt 2, 3", () => {
    const send = vi.fn();
    const track = makeSubmitAttemptTracker("register", send);
    track();
    track();
    track();
    expect(send.mock.calls).toEqual([
      ["register", 1],
      ["register", 2],
      ["register", 3],
    ]);
    // Exactly one call carries attempt 1, the row the step counts.
    expect(send.mock.calls.filter(([, n]) => n === 1)).toHaveLength(1);
  });

  it("a new mount is a new visit and starts again at 1", () => {
    const send = vi.fn();
    makeSubmitAttemptTracker("submit", send)();
    makeSubmitAttemptTracker("submit", send)();
    expect(send.mock.calls).toEqual([
      ["submit", 1],
      ["submit", 1],
    ]);
  });
});

describe("firstSubmitAttempt / submitRetry on real SQLite", () => {
  it("counts attempt 1 and legacy rows as the step, and attempt 2+ as retries", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE analytics_events (
      id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_category TEXT NOT NULL,
      timestamp INTEGER NOT NULL, properties TEXT DEFAULT '{}', user_id TEXT, source TEXT)`);
    const rows: Array<[string, string, string]> = [
      ["legacy", "register_submitted", JSON.stringify({ device: "mobile" })],
      ["a1", "register_submitted", JSON.stringify({ attempt: 1 })],
      ["a2", "register_submitted", JSON.stringify({ attempt: 2 })],
      ["a3", "register_submitted", JSON.stringify({ attempt: 3 })],
      ["view", "register_view", "{}"],
    ];
    const ins = sqlite.prepare(
      "INSERT INTO analytics_events VALUES (?, ?, 'funnel', 1, ?, NULL, 'client_beacon')"
    );
    for (const [id, name, props] of rows) ins.run(id, name, props);
    const db = drizzle(sqlite, { schema });
    const ids = (where: ReturnType<typeof firstSubmitAttempt>) =>
      db
        .select({ id: analyticsEvents.id })
        .from(analyticsEvents)
        .where(where)
        .orderBy(sql`id`)
        .all()
        .map((r) => r.id);

    // Landmark: five rows exist, so a split of 3 + 2 is a filter, not an empty table.
    expect(db.select({ id: analyticsEvents.id }).from(analyticsEvents).all()).toHaveLength(5);
    expect(ids(firstSubmitAttempt(analyticsEvents.properties))).toEqual(["a1", "legacy", "view"]);
    expect(ids(submitRetry(analyticsEvents.properties))).toEqual(["a2", "a3"]);
  });
});
