/**
 * OPE-413 — PENDING queue classification.
 *
 * The queue reached 138 days unwatched, and the reason a count would not have
 * saved it is that its rows are not interchangeable. These tests are mostly
 * about the partition: a row where the fair has already happened must never sit
 * in the same list as one still worth approving, because the first is a decision
 * and the second is just work.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { tunableThresholds } from "../../db/schema";
import {
  getPendingSlaReport,
  readPendingSlaHours,
  summarizePendingSla,
  PENDING_SLA_FALLBACK_HOURS,
  PENDING_SLA_KEY,
} from "../pending-sla";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER, start_date INTEGER,
    suggester_email TEXT, merged_into TEXT, updated_at INTEGER, source_name TEXT
  );
  CREATE TABLE tunable_thresholds (
    key TEXT PRIMARY KEY, value REAL NOT NULL, unit TEXT NOT NULL,
    note TEXT, updated_at INTEGER NOT NULL
  );
`;

const NOW = new Date("2026-08-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seed(
  id: string,
  opts: {
    created: Date;
    start?: Date | null;
    email?: string | null;
    status?: string;
  }
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, created_at, start_date, suggester_email, source_name)
       VALUES (?,?,?,?,?,?,?, 'community-suggestion')`
    )
    .run(
      id,
      `Event ${id}`,
      `event-${id}`,
      opts.status ?? "PENDING",
      Math.floor(opts.created.getTime() / 1000),
      opts.start ? Math.floor(opts.start.getTime() / 1000) : null,
      opts.email ?? null
    );
}

describe("the tunable threshold", () => {
  it("falls back to the published 48h promise when the row is missing", async () => {
    expect(await readPendingSlaHours(db)).toBe(PENDING_SLA_FALLBACK_HOURS);
  });

  it("reads an operator-set value with no redeploy", async () => {
    await db.insert(tunableThresholds).values({
      key: PENDING_SLA_KEY,
      value: 168,
      unit: "hours",
      updatedAt: NOW,
    });
    expect(await readPendingSlaHours(db)).toBe(168);
  });

  it("refuses a zero or negative threshold — far likelier a typo than an intent", async () => {
    // A 0h threshold would mark every row breaching and make the alert useless
    // in exactly the way that got this queue to 138 days.
    await db.insert(tunableThresholds).values({
      key: PENDING_SLA_KEY,
      value: 0,
      unit: "hours",
      updatedAt: NOW,
    });
    expect(await readPendingSlaHours(db)).toBe(PENDING_SLA_FALLBACK_HOURS);
  });
});

describe("classification", () => {
  it("separates someone-waiting from routine backlog", async () => {
    seed("person", { created: daysAgo(10), start: daysAhead(30), email: "a@example.com" });
    seed("bot", { created: daysAgo(10), start: daysAhead(30), email: null });

    const r = await getPendingSlaReport(db, NOW);
    expect(r.waiting.map((x) => x.id)).toEqual(["person"]);
    expect(r.routine.map((x) => x.id)).toEqual(["bot"]);
  });

  it("a fresh submission is not breaching", async () => {
    seed("fresh", {
      created: new Date(NOW.getTime() - 3600_000),
      start: daysAhead(30),
      email: "a@b.c",
    });
    const r = await getPendingSlaReport(db, NOW);
    expect(r.waiting).toHaveLength(0);
    expect(r.routine).toHaveLength(0);
    expect(r.totalPending).toBe(1);
  });

  it("an event whose date has PASSED is expired, never ordinary backlog", async () => {
    // The category the ticket was really about: submissions that sat here until
    // the fair had already happened. Mixing them into the backlog hides the only
    // rows where waiting already cost something irreversible.
    seed("gone", { created: daysAgo(40), start: daysAgo(2), email: "a@example.com" });
    const r = await getPendingSlaReport(db, NOW);
    expect(r.expired.map((x) => x.id)).toEqual(["gone"]);
    expect(r.waiting).toHaveLength(0);
    expect(r.routine).toHaveLength(0);
  });

  it("an event starting within a week is imminent regardless of queue age", async () => {
    // Submitted an hour ago, but the fair is in three days — approving it late
    // is the same as not approving it.
    seed("soon", {
      created: new Date(NOW.getTime() - 3600_000),
      start: daysAhead(3),
      email: "a@b.c",
    });
    const r = await getPendingSlaReport(db, NOW);
    expect(r.imminent.map((x) => x.id)).toEqual(["soon"]);
    expect(r.waiting).toHaveLength(0); // not breaching — it just arrived
  });

  it("orders the waiting list oldest first, as the digest prints it", async () => {
    seed("newer", { created: daysAgo(5), start: daysAhead(30), email: "a@b.c" });
    seed("older", { created: daysAgo(20), start: daysAhead(30), email: "a@b.c" });
    const r = await getPendingSlaReport(db, NOW);
    expect(r.waiting.map((x) => x.id)).toEqual(["older", "newer"]);
  });

  it("ignores rows that are not PENDING", async () => {
    seed("approved", {
      created: daysAgo(30),
      start: daysAhead(30),
      email: "a@b.c",
      status: "APPROVED",
    });
    const r = await getPendingSlaReport(db, NOW);
    expect(r.totalPending).toBe(0);
  });

  it("respects an operator-widened threshold", async () => {
    await db.insert(tunableThresholds).values({
      key: PENDING_SLA_KEY,
      value: 24 * 30,
      unit: "hours",
      updatedAt: NOW,
    });
    seed("tenDays", { created: daysAgo(10), start: daysAhead(60), email: "a@b.c" });
    const r = await getPendingSlaReport(db, NOW);
    expect(r.thresholdHours).toBe(720);
    expect(r.waiting).toHaveLength(0); // 10 days is inside a 30-day window
  });
});

describe("the digest summary", () => {
  it("returns null on a clean queue rather than a row of zeros", async () => {
    // A line reading "0, 0, 0" every Monday trains the reader to skip the block,
    // which is how the real number gets missed when it arrives.
    expect(summarizePendingSla(await getPendingSlaReport(db, NOW))).toBeNull();
  });

  it("leads with the people, not the total", async () => {
    seed("p", { created: daysAgo(9), start: daysAhead(20), email: "a@b.c" });
    seed("gone", { created: daysAgo(40), start: daysAgo(1), email: null });
    const line = summarizePendingSla(await getPendingSlaReport(db, NOW));
    expect(line).toContain("1 with someone waiting");
    expect(line).toContain("1 already past their date");
  });
});
