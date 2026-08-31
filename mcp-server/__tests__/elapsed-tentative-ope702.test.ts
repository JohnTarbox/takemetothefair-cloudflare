/**
 * OPE-702 — the elapsed-but-never-corroborated population.
 *
 * The ticket asked for these 166 rows to be swept to a terminal lifecycle, with
 * the acceptance that the count "goes down and stays near zero". That cannot be
 * done: OPE-675 established the day before that the missing TENTATIVE →
 * OCCURRED edge is deliberate, because for an event nobody confirmed took place
 * the correct lifecycle IS TENTATIVE. Sweeping would manufacture 165 claims
 * nobody made.
 *
 * So what ships is the count, not the sweep — and these tests pin the two
 * things that make the count worth having:
 *
 *  1. The buckets stay SEPARATE. Counting on `start_date` alone reports 209
 *     where the answer is 165: a season row is still running and a NULL
 *     end_date is unjudgeable. The tidy number overstates by 27%.
 *  2. The `not_a_fault` note survives. It is the only thing standing between
 *     this number and someone "fixing" it, which is the one action that must
 *     not be taken on it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import {
  readElapsedTentative,
  ELAPSED_TENTATIVE_NOT_A_FAULT,
} from "../src/events/elapsed-tentative.js";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    status TEXT,
    lifecycle_status TEXT,
    start_date INTEGER,
    end_date INTEGER,
    merged_into TEXT
  );
`;

const NOW = new Date("2026-08-31T12:00:00Z");
const S = Math.floor(NOW.getTime() / 1000);
const DAY = 86400;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(
  id: string,
  startOffsetDays: number,
  endOffsetDays: number | null,
  status = "APPROVED",
  lifecycle = "TENTATIVE",
  mergedInto: string | null = null
) {
  raw
    .prepare(
      `INSERT INTO events (id, slug, name, status, lifecycle_status, start_date, end_date, merged_into)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      id,
      id,
      status,
      lifecycle,
      S + startOffsetDays * DAY,
      endOffsetDays === null ? null : S + endOffsetDays * DAY,
      mergedInto
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the buckets must stay separate", () => {
  it("counts a truly elapsed row", async () => {
    seed("elapsed", -40, -38);
    const r = await readElapsedTentative(db, NOW);
    expect(r.truly_elapsed).toBe(1);
    expect(r.still_running).toBe(0);
    expect(r.end_date_null).toBe(0);
  });

  it("does NOT count a season row whose start is past but end is future", async () => {
    // sandy-river-farmers-market-2026: starts 2026-05-01, runs all season. A
    // past start_date on a season row means nothing. If this ever counts as
    // elapsed, the metric has adopted the 27%-overstating definition.
    seed("season", -120, +30);
    const r = await readElapsedTentative(db, NOW);
    expect(r.truly_elapsed).toBe(0);
    expect(r.still_running).toBe(1);
  });

  it("does NOT count a past-start row with a NULL end_date", async () => {
    // A different question — is a NULL end_date a one-day event or an unbounded
    // one? — and not bulk-judgeable from the row. It gets its own bucket so a
    // sweep can never pick it up by accident.
    seed("nullend", -10, null);
    const r = await readElapsedTentative(db, NOW);
    expect(r.truly_elapsed).toBe(0);
    expect(r.end_date_null).toBe(1);
  });

  it("reproduces the shape of the reported population, not the tidy total", async () => {
    seed("e1", -40, -38);
    seed("e2", -5, -4);
    seed("season", -120, +30);
    seed("nullend", -10, null);

    const r = await readElapsedTentative(db, NOW);
    // 4 rows have a past start_date; only 2 are actually elapsed.
    expect(r.truly_elapsed).toBe(2);
    expect(r.still_running).toBe(1);
    expect(r.end_date_null).toBe(1);
  });
});

describe("scoping", () => {
  it("counts only TENTATIVE lifecycle rows", async () => {
    seed("occurred", -40, -38, "APPROVED", "OCCURRED");
    seed("scheduled", -40, -38, "APPROVED", "SCHEDULED");
    seed("tentative", -40, -38);
    expect((await readElapsedTentative(db, NOW)).truly_elapsed).toBe(1);
  });

  it("excludes merge tombstones", async () => {
    // A tombstone's slug 301s away; counting it would inflate a population
    // nobody can act on.
    seed("tomb", -40, -38, "APPROVED", "TENTATIVE", "keeper");
    expect((await readElapsedTentative(db, NOW)).truly_elapsed).toBe(0);
  });

  it("separates the publicly served subset from the total", async () => {
    // PUBLIC_LIFECYCLE_STATUSES includes TENTATIVE, so an APPROVED elapsed row
    // IS rendered. That distinction is what decides whether this population is
    // a public concern or internal hygiene, so it is reported, not assumed.
    seed("pub", -40, -38, "APPROVED");
    seed("draft", -40, -38, "DRAFT");
    const r = await readElapsedTentative(db, NOW);
    expect(r.truly_elapsed).toBe(2);
    expect(r.publicly_served).toBe(1);
  });
});

describe("the regeneration rate and the oldest offender", () => {
  it("counts only the last 30 days in elapsed_within_30d", async () => {
    seed("recent", -10, -9);
    seed("old", -200, -199);
    const r = await readElapsedTentative(db, NOW);
    expect(r.truly_elapsed).toBe(2);
    expect(r.elapsed_within_30d).toBe(1);
  });

  it("reports the OLDEST elapsed row, so a backlog cannot hide behind fresh arrivals", async () => {
    seed("recent", -10, -9);
    seed("old", -400, -399);
    const r = await readElapsedTentative(db, NOW);
    expect(r.oldest_elapsed_at).toBe(new Date((S - 399 * DAY) * 1000).toISOString());
  });

  it("returns null for oldest_elapsed_at when nothing is elapsed", async () => {
    seed("future", +10, +11);
    const r = await readElapsedTentative(db, NOW);
    expect(r.truly_elapsed).toBe(0);
    expect(r.oldest_elapsed_at).toBeNull();
  });
});

describe("the note is load-bearing", () => {
  it("ships the not_a_fault warning with every read", async () => {
    // This is the only thing standing between the number and someone driving it
    // to zero — which would manufacture a claim nobody made for every row it
    // touched. If the field is ever dropped, this fails.
    const r = await readElapsedTentative(db, NOW);
    expect(r.not_a_fault).toBe(ELAPSED_TENTATIVE_NOT_A_FAULT);
    expect(r.not_a_fault).toMatch(/do not sweep this to zero/i);
    expect(r.not_a_fault).toContain("OPE-675");
  });

  it("carries no `rule` field — every other data-health entry has one", async () => {
    // The report's other entries state a rule whose target is zero. This one has
    // no such target, and giving it a `rule` would file it as a fault.
    expect(Object.keys(await readElapsedTentative(db, NOW))).not.toContain("rule");
  });
});
