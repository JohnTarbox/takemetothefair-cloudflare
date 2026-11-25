/**
 * OPE-1709 — the photo-classify-step probe.
 *
 * Demand = a Snap photo_intake row received after the probe was armed.
 * Evidence = a `photo/cards-only` or `photo/classify` workflow step. The clock
 * starts at the OLDEST unserved demand newer than the newest evidence.
 *
 * Amendment H: every case states the row count it read before trusting the
 * verdict — an empty table satisfies "no evidence" for the wrong reason.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, intent TEXT, routing_source TEXT
  );
  CREATE TABLE workflow_run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT, workflow_name TEXT,
    inbound_email_id TEXT, step_name TEXT, status TEXT, detail TEXT,
    duration_ms INTEGER, recorded_at INTEGER NOT NULL
  );
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "photo-classify-step")!;

const snap = (id: string, at: string, opts: { intent?: string; source?: string | null } = {}) =>
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, intent, routing_source) VALUES (?, ?, ?, ?)`
    )
    .run(
      id,
      T(at),
      opts.intent ?? "photo_intake",
      opts.source === undefined ? "snap-app" : opts.source
    );
const step = (name: string, at: string) =>
  raw
    .prepare(
      `INSERT INTO workflow_run_steps (instance_id, workflow_name, step_name, status, recorded_at) VALUES ('wf', 'inbound-email', ?, 'ok', ?)`
    )
    .run(name, T(at));
const count = (t: string) => (raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
const isNow = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 60_000;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  // As migration 0436 arms it.
  raw
    .prepare(`INSERT INTO heartbeat_probes (probe_name, enabled_at) VALUES (?, ?)`)
    .run("photo-classify-step", T("2026-11-26T00:00:00Z"));
  db = drizzle(raw, { schema });
});

describe("OPE-1709 photo-classify-step probe", () => {
  it("is registered, owned, with a 24h served-ness window", () => {
    expect(probe).toBeTruthy();
    expect(probe.ownerOpe).toBe("OPE-1709");
    expect(probe.expectedWindowHours).toBe(24);
  });

  it("no Snap uploads since arming: healthy, whatever else arrived", async () => {
    snap("emailed", "2026-11-27T00:00:00Z", { source: null }); // an emailed photo
    snap("other", "2026-11-27T01:00:00Z", { intent: "event_submission" });
    snap("before", "2026-11-25T15:05:07Z"); // the OPE-1709 card itself, pre-writer
    expect(count("inbound_emails")).toBe(3);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a Snap upload followed by its step is healthy", async () => {
    snap("s1", "2026-11-27T10:00:00Z");
    step("photo/cards-only", "2026-11-27T10:00:05Z");
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([1, 1]);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("the fair pass's step counts too", async () => {
    snap("s1", "2026-11-27T10:00:00Z");
    step("photo/classify", "2026-11-27T10:00:05Z");
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("RED — a Snap upload with no step after it starts the clock at its receipt", async () => {
    snap("s1", "2026-11-27T10:00:00Z");
    step("photo/cards-only", "2026-11-27T10:00:05Z");
    snap("s2", "2026-11-28T09:00:00Z"); // unserved
    snap("s3", "2026-11-28T12:00:00Z"); // unserved, newer
    step("newsletter/classify", "2026-11-28T12:00:02Z"); // a different step is not evidence
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([3, 2]);
    expect(await probe.lastEvidenceAt(db)).toEqual(new Date("2026-11-28T09:00:00Z"));
  });

  it("dormant if never seeded: an unserved upload does not fire", async () => {
    raw.exec(`DELETE FROM heartbeat_probes`);
    snap("s1", "2026-11-27T10:00:00Z");
    expect(count("inbound_emails")).toBe(1);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });
});
