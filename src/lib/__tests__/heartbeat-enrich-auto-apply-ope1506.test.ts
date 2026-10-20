/**
 * OPE-1506 — the `enrich-auto-apply` probe.
 *
 * Demand: a staged enrich row whose payload names a qualifying sender and at
 * least one eligible field. Evidence: a `dedup.enrich_applied` row. Every case
 * states the row counts it read before trusting the verdict.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, note TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT, target_type TEXT,
    target_id TEXT, payload_json TEXT, created_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "enrich-auto-apply")!;
let n = 0;
const arm = (at: string | null) =>
  raw
    .prepare(
      `INSERT INTO heartbeat_probes (probe_name, enabled_at, updated_at) VALUES ('enrich-auto-apply', ?, 0)`
    )
    .run(at === null ? null : T(at));
const action = (name: string, at: string, payload: unknown = {}) =>
  raw
    .prepare(`INSERT INTO admin_actions (id, action, payload_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(`a${++n}`, name, JSON.stringify(payload), T(at));
const staged = (at: string, basis: string | null, eligible: string[]) =>
  action("dedup.enrich_proposed", at, { autoApply: { basis, eligible, applied: [] } });
const count = () => (raw.prepare(`SELECT COUNT(*) n FROM admin_actions`).get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("OPE-1506 enrich-auto-apply probe", () => {
  it("is registered with a 24h window", () => {
    expect(probe.expectedWindowHours).toBe(24);
  });

  it("dormant reads no evidence", async () => {
    arm(null);
    staged("2026-10-22T10:00:00Z", "trusted", ["estimated_attendance"]);
    expect(count()).toBe(1);
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });

  it("a qualifying match with NO applied row starts the clock at the match", async () => {
    arm("2026-10-20T00:00:00Z");
    staged("2026-10-22T10:00:00Z", "trusted", ["estimated_attendance"]);
    expect(count()).toBe(1);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("an applied row at or after the demand clears it", async () => {
    arm("2026-10-20T00:00:00Z");
    staged("2026-10-22T10:00:00Z", "trusted", ["estimated_attendance"]);
    action("dedup.enrich_applied", "2026-10-22T10:00:01Z");
    expect(count()).toBe(2);
    expect(Date.now() - (await probe.lastEvidenceAt(db))!.getTime()).toBeLessThan(60_000);
  });

  it("no demand from an unqualified sender or a match with nothing eligible", async () => {
    arm("2026-10-20T00:00:00Z");
    staged("2026-10-22T10:00:00Z", null, ["estimated_attendance"]);
    staged("2026-10-22T11:00:00Z", "trusted", []);
    action("dedup.enrich_proposed", "2026-10-22T12:00:00Z", {}); // pre-OPE-1506 shape
    expect(count()).toBe(3);
    expect(Date.now() - (await probe.lastEvidenceAt(db))!.getTime()).toBeLessThan(60_000);
  });

  it("demand before arming is ignored", async () => {
    arm("2026-10-20T00:00:00Z");
    staged("2026-10-19T10:00:00Z", "trusted", ["estimated_attendance"]);
    expect(count()).toBe(1);
    expect(Date.now() - (await probe.lastEvidenceAt(db))!.getTime()).toBeLessThan(60_000);
  });
});
