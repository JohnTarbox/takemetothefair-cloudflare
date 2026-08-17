/**
 * OPE-433 item 6 — measuring confirmed-without-evidence.
 *
 * `events.dates_confirmed` is an independent boolean defaulting to TRUE, and
 * nothing checks it against `event_data_citations`. So "confirmed" means
 * "nobody said otherwise", not "we have a source" — 1,244 of 1,374 live events
 * in production (90.5%).
 *
 * These tests pin the measurement only. Nothing here enforces or rewrites a
 * value: `dates_confirmed` has four customer-facing consumers, including
 * Schema.org JSON-LD, so remediation is a separate decision.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  getDatesConfirmedBasis,
  getDatesConfirmedReport,
  summarizeDatesConfirmed,
} from "../dates-confirmed-basis";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    status TEXT NOT NULL, dates_confirmed INTEGER, ingestion_method TEXT,
    merged_into TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE event_data_citations (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, field_name TEXT NOT NULL,
    value TEXT, source_url TEXT, source_type TEXT, confidence REAL,
    state TEXT NOT NULL, supersedes_citation_id TEXT, created_by TEXT,
    year INTEGER, created_at INTEGER
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

function seedEvent(
  id: string,
  opts: { confirmed?: boolean; method?: string; status?: string; merged?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, dates_confirmed, ingestion_method, merged_into)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      id,
      `Event ${id}`,
      `event-${id}`,
      opts.status ?? "APPROVED",
      opts.confirmed === false ? 0 : 1,
      opts.method ?? "aggregator_import",
      opts.merged ?? null
    );
}

function seedCitation(id: string, eventId: string, field: string, state = "active") {
  raw
    .prepare(`INSERT INTO event_data_citations (id, event_id, field_name, state) VALUES (?,?,?,?)`)
    .run(id, eventId, field, state);
}

describe("the claim vs the evidence", () => {
  it("counts a confirmed event with no date citation as uncited", async () => {
    seedEvent("e1");
    const r = await getDatesConfirmedReport(db);
    expect(r.claimsConfirmed).toBe(1);
    expect(r.confirmedUncited).toBe(1);
  });

  it("a start_date citation backs the claim", async () => {
    seedEvent("e1");
    seedCitation("c1", "e1", "start_date");
    expect((await getDatesConfirmedReport(db)).confirmedUncited).toBe(0);
  });

  it("an end_date citation backs it too", async () => {
    seedEvent("e1");
    seedCitation("c1", "e1", "end_date");
    expect((await getDatesConfirmedReport(db)).confirmedUncited).toBe(0);
  });

  it("a citation on a NON-date field does not back a dates claim", async () => {
    // The whole point is field-level provenance. An attendance citation says
    // nothing about whether the dates are right.
    seedEvent("e1");
    seedCitation("c1", "e1", "estimated_attendance");
    expect((await getDatesConfirmedReport(db)).confirmedUncited).toBe(1);
  });

  it("a superseded citation does not back the claim", async () => {
    // Only state='active' counts — a superseded row is history, not evidence
    // for the value currently stored.
    seedEvent("e1");
    seedCitation("c1", "e1", "start_date", "superseded");
    expect((await getDatesConfirmedReport(db)).confirmedUncited).toBe(1);
  });

  it("an event not claiming confirmation is never counted as uncited", async () => {
    seedEvent("e1", { confirmed: false });
    const r = await getDatesConfirmedReport(db);
    expect(r.claimsConfirmed).toBe(0);
    expect(r.confirmedUncited).toBe(0);
  });
});

describe("scope", () => {
  it("ignores non-live and merged rows", async () => {
    seedEvent("rejected", { status: "REJECTED" });
    seedEvent("tombstone", { merged: "keeper" });
    const r = await getDatesConfirmedReport(db);
    expect(r.liveEvents).toBe(0);
  });

  it("counts TENTATIVE as live — it is publicly visible", async () => {
    seedEvent("t", { status: "TENTATIVE" });
    expect((await getDatesConfirmedReport(db)).liveEvents).toBe(1);
  });
});

describe("per-lane breakdown", () => {
  it("ranks the worst offender first", async () => {
    seedEvent("a1", { method: "aggregator_import" });
    seedEvent("a2", { method: "aggregator_import" });
    seedEvent("v1", { method: "vendor_submission" });
    const r = await getDatesConfirmedReport(db);
    expect(r.byIngestionMethod[0].ingestionMethod).toBe("aggregator_import");
    expect(r.byIngestionMethod[0].confirmedUncited).toBe(2);
  });

  it("reports the annual_rollover shape — claims nothing, so owes nothing", async () => {
    // The reference lane: it declines to claim confirmation, so it has no
    // unbacked claims by construction. This is the target behaviour.
    seedEvent("r1", { method: "annual_rollover", confirmed: false });
    const lane = (await getDatesConfirmedReport(db)).byIngestionMethod.find(
      (l) => l.ingestionMethod === "annual_rollover"
    )!;
    expect(lane.claimsConfirmed).toBe(0);
    expect(lane.confirmedUncited).toBe(0);
    expect(lane.uncitedShare).toBe(0); // not NaN — the divide is guarded
  });

  it("buckets a null ingestion_method as 'unknown' rather than dropping it", async () => {
    raw
      .prepare(
        `INSERT INTO events (id,name,slug,status,dates_confirmed,ingestion_method) VALUES (?,?,?,?,1,NULL)`
      )
      .run("n1", "N", "n", "APPROVED");
    const r = await getDatesConfirmedReport(db);
    expect(r.byIngestionMethod.some((l) => l.ingestionMethod === "unknown")).toBe(true);
  });
});

describe("per-event basis", () => {
  it("classifies the three states", async () => {
    seedEvent("cited");
    seedCitation("c1", "cited", "start_date");
    seedEvent("uncited");
    seedEvent("unclaimed", { confirmed: false });

    expect(await getDatesConfirmedBasis(db, "cited")).toBe("cited");
    expect(await getDatesConfirmedBasis(db, "uncited")).toBe("uncited");
    expect(await getDatesConfirmedBasis(db, "unclaimed")).toBe("unclaimed");
  });

  it("treats a missing event as unclaimed rather than throwing", async () => {
    expect(await getDatesConfirmedBasis(db, "nope")).toBe("unclaimed");
  });
});

describe("digest summary", () => {
  it("returns null when every confirmation is backed", async () => {
    seedEvent("e1");
    seedCitation("c1", "e1", "start_date");
    expect(summarizeDatesConfirmed(await getDatesConfirmedReport(db))).toBeNull();
  });

  it("names the count, the share and the worst lane", async () => {
    seedEvent("a1", { method: "aggregator_import" });
    seedEvent("a2", { method: "aggregator_import" });
    const line = summarizeDatesConfirmed(await getDatesConfirmedReport(db));
    expect(line).toContain("2 of 2");
    expect(line).toContain("100%");
    expect(line).toContain("aggregator_import");
  });
});
