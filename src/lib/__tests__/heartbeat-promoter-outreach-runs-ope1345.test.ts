/**
 * OPE-1345 — the promoter-outreach probe reads the lane's RUN stamp, not only sends.
 *
 * The weekly lane is research-first (John, 2026-10-13: ruling A, amended): most
 * weeks it fixes listings from the organizer's own page and sends nothing. The
 * old probe read `promoter_outreach_attempts` alone, so a working lane looked
 * like 19 days of silence. Evidence is now the newer of a run row and an attempt.
 *
 * Amendment H: "no evidence" is satisfied by empty tables, so every case states
 * the row counts it read before trusting the verdict.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE promoter_outreach_attempts (
    id TEXT PRIMARY KEY, promoter_id TEXT NOT NULL, event_id TEXT,
    channel TEXT NOT NULL DEFAULT 'email', to_address TEXT NOT NULL,
    subject TEXT NOT NULL, body_text TEXT NOT NULL, reason TEXT,
    status TEXT NOT NULL DEFAULT 'queued', requested_by TEXT,
    created_at INTEGER NOT NULL, sent_at INTEGER, outcome_at INTEGER,
    inbound_email_id TEXT, provider_message_id TEXT, follow_up_of TEXT
  );
  CREATE TABLE promoter_outreach_runs (
    id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL,
    events_reviewed INTEGER NOT NULL DEFAULT 0, resolved_from_web INTEGER NOT NULL DEFAULT 0,
    drafts_for_approval INTEGER NOT NULL DEFAULT 0, emails_sent INTEGER NOT NULL DEFAULT 0,
    recorded_by TEXT, note TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "promoter-outreach-attempts")!;

const seedAttempt = (id: string, at: string) =>
  raw
    .prepare(
      `INSERT INTO promoter_outreach_attempts (id, promoter_id, to_address, subject, body_text, created_at)
       VALUES (?, 'p1', 'x@example.org', 's', 'b', ?)`
    )
    .run(id, T(at));
const seedRun = (id: string, at: string) =>
  raw.prepare(`INSERT INTO promoter_outreach_runs (id, ran_at) VALUES (?, ?)`).run(id, T(at));
const count = (table: string) =>
  (raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("OPE-1345 promoter-outreach probe", () => {
  it("is registered with a weekly-plus-slack window (9 days)", () => {
    expect(probe).toBeTruthy();
    expect(probe.expectedWindowHours).toBe(9 * 24);
  });

  it("a run that sent nothing is evidence — the case the old probe read as silence", async () => {
    seedAttempt("a1", "2026-09-23T16:48:00Z"); // the one real send
    seedRun("r1", "2026-10-20T13:00:00Z"); // research-only week
    expect([count("promoter_outreach_attempts"), count("promoter_outreach_runs")]).toEqual([1, 1]);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-20T13:00:00.000Z");
  });

  it("an attempt newer than the last run still counts", async () => {
    seedRun("r1", "2026-10-20T13:00:00Z");
    seedAttempt("a1", "2026-10-21T09:00:00Z");
    expect([count("promoter_outreach_attempts"), count("promoter_outreach_runs")]).toEqual([1, 1]);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-21T09:00:00.000Z");
  });

  it("no runs: falls back to attempts alone (today's prod state)", async () => {
    seedAttempt("a1", "2026-09-23T16:48:00Z");
    expect(count("promoter_outreach_runs")).toBe(0);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-09-23T16:48:00.000Z");
  });

  it("both empty reads as never-produced (null), not as fresh", async () => {
    expect([count("promoter_outreach_attempts"), count("promoter_outreach_runs")]).toEqual([0, 0]);
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });
});
