/**
 * OPE-447 — the outage clock must not reset when the operator probes Bing.
 *
 * The headline test is `monotonicity` below. It replays the REAL production
 * sequence from `admin_actions` — three resume → probe(429) → re-pause cycles
 * on 2026-06-27, 2026-07-18 and 2026-08-11 — and asserts the reported figure
 * never decreases. Against the old implementation (age parsed from the
 * `indexnow:paused` value) it fails on the first cycle, which is the property
 * the ticket asked for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import {
  getIndexNowOutage,
  describeIndexNowOutage,
  advanceIndexNowOutageAnchor,
  INDEXNOW_LAST_KNOWN_SUCCESS_EPOCH,
  INDEXNOW_OUTAGE_ANCHOR_KEY,
} from "../indexnow-outage";

const SCHEMA_SQL = `
  CREATE TABLE indexnow_submissions (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, source TEXT NOT NULL,
    urls TEXT NOT NULL DEFAULT '[]', url_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, http_status INTEGER, error_message TEXT
  );
  CREATE TABLE tunable_thresholds (
    key TEXT PRIMARY KEY, value REAL NOT NULL, unit TEXT NOT NULL,
    note TEXT, updated_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

const at = (iso: string) => new Date(iso);
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function seedSubmission(id: string, iso: string, status: string) {
  raw
    .prepare(
      `INSERT INTO indexnow_submissions (id, timestamp, source, status) VALUES (?,?,'test',?)`
    )
    .run(id, epoch(iso), status);
}

function seedAnchor(iso: string) {
  raw
    .prepare(
      `INSERT INTO tunable_thresholds (key, value, unit, updated_at)
       VALUES (?,?,'unix_epoch_seconds', 0)`
    )
    .run(INDEXNOW_OUTAGE_ANCHOR_KEY, epoch(iso));
}

/** The pause age the OLD implementation reported: now − last re-pause. */
function pauseAgeDays(nowIso: string, pausedAtIso: string): number {
  return Math.floor((Date.parse(nowIso) - Date.parse(pausedAtIso)) / 86_400_000);
}

describe("monotonicity across the real probe-and-re-pause cycles", () => {
  // Straight from admin_actions. Each is resume → resubmit(429) → pause.
  const REPAUSES = ["2026-06-27T03:07:44Z", "2026-07-18T01:44:44Z", "2026-08-11T03:08:44Z"];
  const SAMPLES = [
    "2026-06-20T12:00:00Z",
    "2026-07-10T12:00:00Z",
    "2026-07-21T02:00:00Z",
    "2026-08-10T12:00:00Z",
    "2026-08-17T12:00:00Z",
  ];

  it("the reported outage never decreases", async () => {
    seedAnchor("2026-06-13T02:47:47Z");
    let previous = -1;
    for (const iso of SAMPLES) {
      const { days } = await getIndexNowOutage(db, at(iso));
      expect(days).toBeGreaterThanOrEqual(previous);
      previous = days;
    }
  });

  it("the OLD anchor (pause age) DOES decrease — this is the defect", () => {
    // Documents what we replaced. On 2026-08-10 the old alert said 23; a week
    // later, after the 08-11 re-pause, it said 6. Same continuous outage.
    const before = pauseAgeDays("2026-08-10T12:00:00Z", REPAUSES[1]);
    const after = pauseAgeDays("2026-08-17T12:00:00Z", REPAUSES[2]);
    expect(before).toBe(23); // matches the real 2026-08-10 alert
    expect(after).toBe(6); // matches the real 2026-08-17 alert
    expect(after).toBeLessThan(before); // the reset, reproduced
  });

  it("reports 50+ days on the date the ticket was filed", async () => {
    // Acceptance: the next alert must report a figure consistent with the true
    // outage, not single digits.
    seedAnchor("2026-06-13T02:47:47Z");
    const { days } = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    expect(days).toBeGreaterThanOrEqual(50);
    expect(days).toBe(65);
  });
});

describe("anchor resolution", () => {
  it("prefers a real success over the seed, retiring the seed permanently", async () => {
    seedAnchor("2026-06-13T02:47:47Z");
    seedSubmission("s1", "2026-08-15T00:00:00Z", "success");
    const outage = await getIndexNowOutage(db, at("2026-08-17T00:00:00Z"));
    expect(outage.fromRealSuccess).toBe(true);
    expect(outage.days).toBe(2);
  });

  it("ignores failure and skipped rows — only an accepted submission counts", async () => {
    // 767 'skipped' rows exist in production. Treating any of them as an anchor
    // would report the outage as zero while it is at its worst.
    seedAnchor("2026-06-13T02:47:47Z");
    seedSubmission("f1", "2026-08-16T00:00:00Z", "failure");
    seedSubmission("k1", "2026-08-16T12:00:00Z", "skipped");
    const outage = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    expect(outage.fromRealSuccess).toBe(false);
    expect(outage.days).toBe(65);
  });

  it("picks the NEWEST success when several exist", async () => {
    seedSubmission("s1", "2026-08-01T00:00:00Z", "success");
    seedSubmission("s2", "2026-08-14T00:00:00Z", "success");
    const outage = await getIndexNowOutage(db, at("2026-08-17T00:00:00Z"));
    expect(outage.days).toBe(3);
  });

  it("falls back to the compiled-in constant when the seed row is absent", async () => {
    // A fresh DB, or a failed migration. Reporting 0 here would be the same
    // silence the ticket is about, so the constant is the last line of defence.
    const outage = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    expect(outage.lastSuccessEpoch).toBe(INDEXNOW_LAST_KNOWN_SUCCESS_EPOCH);
    expect(outage.days).toBe(65);
  });

  it("never reports a negative age if the anchor is somehow in the future", async () => {
    seedAnchor("2027-01-01T00:00:00Z");
    const outage = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    expect(outage.days).toBe(0);
  });
});

describe("the 30-day pruning trap", () => {
  // recordSubmission probabilistically deletes indexnow_submissions rows older
  // than 30 days. So a real success row is GUARANTEED to disappear during any
  // outage longer than that — and an implementation that preferred the
  // submissions table and fell back to the seed would report a fabricated
  // multi-month outage the moment the row was pruned.
  it("does not regress to the seed when the success row is pruned away", async () => {
    seedAnchor("2026-06-13T02:47:47Z");
    // Bing accepts a submission; the anchor advances.
    await advanceIndexNowOutageAnchor(db, at("2026-09-01T00:00:00Z"));
    seedSubmission("s1", "2026-09-01T00:00:00Z", "success");

    // 35 days later the submission row is pruned. The anchor must hold.
    raw["prepare"]("DELETE FROM indexnow_submissions").run();

    const outage = await getIndexNowOutage(db, at("2026-10-06T00:00:00Z"));
    expect(outage.days).toBe(35); // NOT ~115 from the stale seed
    expect(outage.fromRealSuccess).toBe(true);
  });

  it("the anchor ratchets — a late or out-of-order call cannot reopen an outage", async () => {
    await advanceIndexNowOutageAnchor(db, at("2026-09-01T00:00:00Z"));
    await advanceIndexNowOutageAnchor(db, at("2026-08-01T00:00:00Z")); // older, must not win
    const outage = await getIndexNowOutage(db, at("2026-09-03T00:00:00Z"));
    expect(outage.days).toBe(2);
  });

  it("takes the later of the submission row and the stored anchor", async () => {
    // Stored anchor is newer than any surviving row.
    await advanceIndexNowOutageAnchor(db, at("2026-09-10T00:00:00Z"));
    seedSubmission("old", "2026-09-01T00:00:00Z", "success");
    const outage = await getIndexNowOutage(db, at("2026-09-12T00:00:00Z"));
    expect(outage.days).toBe(2);
  });
});

describe("the operator-facing sentence", () => {
  it("leads with the outage and labels the pause age separately", async () => {
    seedAnchor("2026-06-13T02:47:47Z");
    const outage = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    const line = describeIndexNowOutage(outage, 6);
    // The two numbers must both be present and distinguishable — conflating
    // them is what reported a 65-day outage as "6 days".
    expect(line).toContain("65 days");
    expect(line).toContain("6 days");
    expect(line).toContain("last success 2026-06-13");
  });

  it("says 'at least' while running off the seed, and drops it on a real success", async () => {
    seedAnchor("2026-06-13T02:47:47Z");
    const seeded = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    expect(describeIndexNowOutage(seeded, 6)).toContain("at least");

    seedSubmission("s1", "2026-08-15T00:00:00Z", "success");
    const real = await getIndexNowOutage(db, at("2026-08-17T12:00:00Z"));
    expect(describeIndexNowOutage(real, 6)).not.toContain("at least");
  });
});
