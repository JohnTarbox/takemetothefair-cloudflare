/**
 * OPE-1316 Ask 1 — a high-trust page the holdout sampler cannot compare across
 * 3+ cooldown cycles raises ONE error-level alert, instead of being retried
 * quietly every 8 days forever (mafa.org: not comparable on every visit for a
 * month, and nobody was told). Evidence = the job's own holdoutOutcome rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  alertPersistentlyUnreadable,
  notComparableUrls,
  PERSISTENT_UNREADABLE_MESSAGE,
} from "../src/goodwill/holdout-sampling.js";

const SOURCE = "mcp:schedule:holdout-sampling";
const NOW = new Date("2026-10-06T06:10:00Z");
const MAFA = "https://www.mafa.org/2026fairsbydate.html";

let db: TestDb;
let raw: Database.Database;
let seq = 0;

beforeEach(() => {
  ({ db, raw } = createTestDb());
});
afterEach(() => raw.close());

function outcomeRow(url: string, isoDay: string, outcome = "extract_failed") {
  raw
    .prepare(
      `INSERT INTO error_logs (id, timestamp, level, message, context, source) VALUES (?, ?, 'warn', ?, ?, ?)`
    )
    .run(
      `r${++seq}`,
      Math.floor(new Date(`${isoDay}T06:10:00Z`).getTime() / 1000),
      "submitExtract failed",
      JSON.stringify({ sourceUrl: url, holdoutOutcome: outcome }),
      SOURCE
    );
}
const alerts = () =>
  raw
    .prepare(`SELECT context FROM error_logs WHERE message = ? AND level = 'error'`)
    .all(PERSISTENT_UNREADABLE_MESSAGE) as { context: string }[];

describe("alertPersistentlyUnreadable", () => {
  it("3 not-comparable visits on 3 distinct days (the prod mafa.org shape) → one alert", async () => {
    for (const d of ["2026-09-17", "2026-09-25", "2026-10-03"]) outcomeRow(MAFA, d);
    expect(await alertPersistentlyUnreadable(db, NOW, SOURCE)).toBe(1);
    const [a] = alerts();
    expect(JSON.parse(a.context)).toMatchObject({
      sourceUrl: MAFA,
      notComparableDays: 3,
      attempts: 3,
    });
  });

  it("2 days is not yet persistent — no alert (positive landmark: the rows ARE there)", async () => {
    outcomeRow(MAFA, "2026-09-25");
    outcomeRow(MAFA, "2026-10-03");
    expect((await notComparableUrls(db, NOW)).has(MAFA)).toBe(true);
    expect(await alertPersistentlyUnreadable(db, NOW, SOURCE)).toBe(0);
  });

  it("several failures on ONE day count as one day", async () => {
    for (let i = 0; i < 7; i++) outcomeRow(MAFA, "2026-10-03");
    expect(await alertPersistentlyUnreadable(db, NOW, SOURCE)).toBe(0);
  });

  it("alerts ONCE: the next run (and the one after) raises nothing new for that page", async () => {
    for (const d of ["2026-09-17", "2026-09-25", "2026-10-03"]) outcomeRow(MAFA, d);
    expect(await alertPersistentlyUnreadable(db, NOW, SOURCE)).toBe(1);
    expect(await alertPersistentlyUnreadable(db, NOW, SOURCE)).toBe(0);
    outcomeRow(MAFA, "2026-10-05");
    expect(await alertPersistentlyUnreadable(db, new Date("2026-10-06T06:10:00Z"), SOURCE)).toBe(0);
    expect(alerts()).toHaveLength(1);
  });

  it("the alert row never feeds the cooldown or the count (it carries no holdoutOutcome)", async () => {
    for (const d of ["2026-09-17", "2026-09-25", "2026-10-03"]) outcomeRow(MAFA, d);
    await alertPersistentlyUnreadable(db, NOW, SOURCE);
    expect(JSON.parse(alerts()[0].context).holdoutOutcome).toBeUndefined();
  });

  it("each persistent page is alerted separately; rows older than 30 days do not count", async () => {
    const other = "https://littlevillefair.com/";
    for (const d of ["2026-09-17", "2026-09-25", "2026-10-03"]) outcomeRow(other, d, "multi_event");
    for (const d of ["2026-08-01", "2026-08-09", "2026-08-17"]) outcomeRow(MAFA, d);
    expect(await alertPersistentlyUnreadable(db, NOW, SOURCE)).toBe(1);
    expect(JSON.parse(alerts()[0].context).sourceUrl).toBe(other);
  });
});
