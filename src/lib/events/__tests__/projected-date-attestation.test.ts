/**
 * OPE-740 scope 5 — the three-way classification, against real SQL.
 *
 * The substance here is the query, not the pure classifier: the buckets are
 * built from two `notExists` subqueries composed inside `SUM(CASE WHEN …)`, and
 * that composition is the part most likely to be silently wrong. A
 * hand-verified count against a fixture is the only thing that shows it.
 *
 * Measured against prod on 2026-09-06 the split is 2 attested / 99 checkable /
 * 23 silent out of 124.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  assessProjectedDateAttestation,
  classifyAttestation,
  loadProjectedDateAttestation,
  PROJECTED_ROW_CAP,
} from "../projected-date-attestation";

// Column names copied from `packages/db-schema/src/index.ts`, not invented.
// ⚠️ OPE-813's lesson: a fixture table carrying a column the real one lacks
// makes a broken query pass locally and fail in prod.
const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT, slug TEXT,
    status TEXT NOT NULL DEFAULT 'TENTATIVE', merged_into TEXT,
    source_url TEXT, ingestion_method TEXT, rolled_from_event_id TEXT,
    start_date INTEGER, created_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE event_data_citations (
    id TEXT PRIMARY KEY, event_id TEXT, field_name TEXT, state TEXT
  );
  CREATE TABLE event_days (
    id TEXT PRIMARY KEY, event_id TEXT, date TEXT
  );
`;

const NOW = new Date("2026-09-06T12:00:00Z");
const JUNE = Math.floor(new Date("2026-06-15T00:00:00Z").getTime() / 1000);

let raw: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

function addEvent(o: {
  id: string;
  method?: string | null;
  url?: string | null;
  rolledFrom?: string | null;
  status?: string;
  merged?: string | null;
  createdAt?: number;
}) {
  raw
    .prepare(
      `INSERT INTO events (id,name,slug,status,merged_into,source_url,ingestion_method,rolled_from_event_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      o.id,
      o.id,
      o.id,
      o.status ?? "TENTATIVE",
      o.merged ?? null,
      o.url ?? null,
      o.method ?? null,
      o.rolledFrom ?? null,
      o.createdAt ?? JUNE
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("classifyAttestation", () => {
  it("attestation beats a missing URL", () => {
    // ⚠️ The specimen that decides the bucket ordering. The two
    // dates_confirmed=1 rows are backed AND wrong — a STOP-gated defect of a
    // different kind. Letting "no URL" outrank "has a citation" would file them
    // as unfalsifiable and make the escalating bucket 25 for the wrong reason.
    expect(
      classifyAttestation({ hasDateCitation: true, hasEventDays: false, sourceUrl: null })
    ).toBe("attested");
    expect(classifyAttestation({ hasDateCitation: false, hasEventDays: true, sourceUrl: "" })).toBe(
      "attested"
    );
  });

  it("a URL alone is checkable, nothing at all is silent", () => {
    expect(
      classifyAttestation({
        hasDateCitation: false,
        hasEventDays: false,
        sourceUrl: "https://x.org",
      })
    ).toBe("checkable");
    expect(
      classifyAttestation({ hasDateCitation: false, hasEventDays: false, sourceUrl: null })
    ).toBe("silent");
  });

  it("a whitespace-only URL is not a URL", () => {
    expect(
      classifyAttestation({ hasDateCitation: false, hasEventDays: false, sourceUrl: "   " })
    ).toBe("silent");
  });
});

describe("loadProjectedDateAttestation — the SQL", () => {
  it("counts the three buckets", async () => {
    addEvent({ id: "silent-1", method: "annual_rollover" });
    addEvent({ id: "silent-2", method: "manual_rollover", url: "" });
    addEvent({ id: "check-1", method: "annual_rollover", url: "https://a.org" });
    addEvent({ id: "check-2", method: "auto_rollover", url: "https://b.org" });
    addEvent({ id: "attest-cite", method: "annual_rollover" });
    raw
      .prepare(`INSERT INTO event_data_citations VALUES (?,?,?,?)`)
      .run("c1", "attest-cite", "start_date", "active");
    addEvent({ id: "attest-days", method: "annual_rollover" });
    raw.prepare(`INSERT INTO event_days VALUES (?,?,?)`).run("d1", "attest-days", "2027-06-01");

    const s = await loadProjectedDateAttestation(db);
    expect(s).toMatchObject({ total: 6, silent: 2, checkable: 2, attested: 2 });
  });

  it("the lineage FK alone brings a row into scope", async () => {
    // The live writer's cohort. Its ingestion_method is covered too, but a
    // future path could set the FK under a method nobody listed.
    addEvent({ id: "lineage", method: "web_research", rolledFrom: "prior-1" });
    const s = await loadProjectedDateAttestation(db);
    expect(s.total).toBe(1);
    expect(s.silent).toBe(1);
  });

  it("⚠️ a non-rollover event is NOT counted", async () => {
    // The positive landmark. Without it, a query that dropped its WHERE clause
    // would satisfy every count above and report the entire events table.
    addEvent({ id: "ordinary", method: "email_submission" });
    addEvent({ id: "no-method" });
    const s = await loadProjectedDateAttestation(db);
    expect(s).toMatchObject({ total: 0, silent: 0, checkable: 0, attested: 0 });
    expect(s.oldestSilentAt).toBeNull();
  });

  it("tombstones and rejects are excluded", async () => {
    // A merged row's slug 301s to its keeper — it renders nothing, so it cannot
    // mislead a reader, and counting it would inflate the red with pages that
    // do not exist.
    addEvent({ id: "keep", method: "annual_rollover" });
    addEvent({ id: "merged", method: "annual_rollover", merged: "keep" });
    addEvent({ id: "rejected", method: "annual_rollover", status: "REJECTED" });
    const s = await loadProjectedDateAttestation(db);
    expect(s.total).toBe(1);
    expect(s.silent).toBe(1);
  });

  it("a superseded citation does not count as attestation", async () => {
    // The near-miss. `state != 'active'` means the claim was withdrawn; the
    // date is back to being unbacked.
    addEvent({ id: "stale-cite", method: "annual_rollover" });
    raw
      .prepare(`INSERT INTO event_data_citations VALUES (?,?,?,?)`)
      .run("c1", "stale-cite", "start_date", "superseded");
    const s = await loadProjectedDateAttestation(db);
    expect(s.silent).toBe(1);
    expect(s.attested).toBe(0);
  });

  it("a citation on a NON-date field does not count", async () => {
    addEvent({ id: "fee-cite", method: "annual_rollover" });
    raw
      .prepare(`INSERT INTO event_data_citations VALUES (?,?,?,?)`)
      .run("c1", "fee-cite", "vendor_fee_min", "active");
    const s = await loadProjectedDateAttestation(db);
    expect(s.silent).toBe(1);
    expect(s.attested).toBe(0);
  });

  it("⚠️ oldestSilentAt tracks the oldest SILENT row, not the oldest row", async () => {
    const older = Math.floor(new Date("2026-06-13T00:00:00Z").getTime() / 1000);
    // A checkable row that is older still — it must NOT set the clock, or the
    // red would age against a row that is not the problem.
    addEvent({
      id: "old-checkable",
      method: "annual_rollover",
      url: "https://a.org",
      createdAt: 1,
    });
    addEvent({ id: "silent-old", method: "annual_rollover", createdAt: older });
    addEvent({ id: "silent-new", method: "annual_rollover", createdAt: JUNE });
    const s = await loadProjectedDateAttestation(db);
    // The clock must age against the rows that are the problem. A checkable
    // row from 1970 setting it would make hoursInRed ~490,000 and the red
    // permanently maximal, for a row that is not what the red is about.
    expect(s.oldestSilentAt?.toISOString()).toBe("2026-06-13T00:00:00.000Z");
  });
});

describe("the per-row artifact", () => {
  it("names each row and its bucket", async () => {
    // Scope 5 asks for a per-ROW classification. Counts cannot answer "which
    // ones", which is the question an operator or a follow-up sweep has.
    addEvent({ id: "s1", method: "annual_rollover" });
    addEvent({ id: "c1", method: "annual_rollover", url: "https://a.org" });
    addEvent({ id: "a1", method: "annual_rollover" });
    raw
      .prepare(`INSERT INTO event_data_citations VALUES (?,?,?,?)`)
      .run("cit", "a1", "end_date", "active");

    const s = await loadProjectedDateAttestation(db);
    const byId = new Map(s.rows.map((r) => [r.id, r]));
    expect(byId.get("s1")!.bucket).toBe("silent");
    expect(byId.get("c1")!.bucket).toBe("checkable");
    expect(byId.get("a1")!.bucket).toBe("attested");
    expect(byId.get("c1")!.sourceUrl).toBe("https://a.org");
    expect(byId.get("s1")!.createdAt?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("⚠️ a truncated scan says so — it does not report a smaller number", async () => {
    // "23 silent" and "at least 23, we stopped counting" are different claims.
    // Four fixes shipped this session are for exactly that collapse; this is
    // the same defect one layer down, so it gets its own flag rather than
    // hiding behind a plausible count.
    for (let i = 0; i < PROJECTED_ROW_CAP + 5; i++) {
      addEvent({ id: `bulk-${i}`, method: "annual_rollover" });
    }
    const s = await loadProjectedDateAttestation(db);
    expect(s.complete).toBe(false);
    expect(s.total).toBe(PROJECTED_ROW_CAP);

    const red = assessProjectedDateAttestation(s, NOW);
    expect(red!.title).toContain("lower bound");
  });

  it("an untruncated scan is marked complete and says nothing about caps", async () => {
    // Positive landmark: `complete` must not be hard-wired false.
    addEvent({ id: "one", method: "annual_rollover" });
    const s = await loadProjectedDateAttestation(db);
    expect(s.complete).toBe(true);
    expect(assessProjectedDateAttestation(s, NOW)!.title).not.toContain("lower bound");
  });
});

describe("assessProjectedDateAttestation", () => {
  const base = { attested: 2, checkable: 99, silent: 23, total: 124, rows: [], complete: true };

  it("fires on the measured prod shape", () => {
    const red = assessProjectedDateAttestation(
      { ...base, oldestSilentAt: new Date("2026-06-13T00:00:00Z") },
      NOW
    );
    expect(red).not.toBeNull();
    expect(red!.refKey).toBe("event-dates:projected-unfalsifiable");
    expect(red!.title).toContain("23");
    expect(red!.hoursInRed).toBeGreaterThan(1900);
  });

  it("⚠️ stays silent when the SILENT bucket is empty, however many are checkable", () => {
    // The positive landmark on the assessor. The red is NOT "we publish
    // projected dates" — that is fine and now labelled. 99 checkable rows with
    // zero silent ones is a healthy state, and a red here would train the
    // operator to ignore the whole signal.
    expect(
      assessProjectedDateAttestation(
        {
          attested: 2,
          checkable: 99,
          silent: 0,
          total: 101,
          rows: [],
          complete: true,
          oldestSilentAt: null,
        },
        NOW
      )
    ).toBeNull();
  });

  it("⚠️ the gate is the SILENT count, not the total and not the clock", () => {
    // Pins the two conditions apart. The test above passes oldestSilentAt=null,
    // so the `|| oldestSilentAt === null` branch returns null on its own and
    // the count gate goes unexercised — a mutation changing `state.silent` to
    // `state.total` survived the whole suite. Supplying a non-null clock with
    // zero silent rows is the only input that isolates the count.
    expect(
      assessProjectedDateAttestation(
        {
          attested: 2,
          checkable: 99,
          silent: 0,
          total: 101,
          rows: [],
          complete: true,
          oldestSilentAt: new Date("2026-06-13T00:00:00Z"),
        },
        NOW
      )
    ).toBeNull();
  });

  it("no clock means no red — hoursInRed must never be invented", () => {
    expect(assessProjectedDateAttestation({ ...base, oldestSilentAt: null }, NOW)).toBeNull();
  });

  it("the refKey carries no count, so the digest does not re-mail on drift", () => {
    const a = assessProjectedDateAttestation(
      { ...base, oldestSilentAt: new Date("2026-06-13T00:00:00Z") },
      NOW
    );
    const b = assessProjectedDateAttestation(
      { ...base, silent: 24, oldestSilentAt: new Date("2026-06-13T00:00:00Z") },
      NOW
    );
    expect(a!.refKey).toBe(b!.refKey);
    expect(a!.title).not.toBe(b!.title);
  });
});
