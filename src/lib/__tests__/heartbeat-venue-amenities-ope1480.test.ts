/**
 * OPE-1480 — the venue-google-amenities probe: demand-conditional, floored at
 * enabled_at, and red only when a NEW venue with a place id went unfilled.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, google_place_id TEXT, accessibility TEXT, parking TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "venue-google-amenities")!;
const venue = (id: string, at: string, pid: string | null, a: string | null, p: string | null) =>
  raw
    .prepare(
      `INSERT INTO venues (id, google_place_id, accessibility, parking, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, pid, a, p, T(at));
const isNow = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 60_000;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  raw
    .prepare(`INSERT INTO heartbeat_probes (probe_name, enabled_at) VALUES (?, ?)`)
    .run("venue-google-amenities", T("2026-10-18T00:00:00Z"));
  db = drizzle(raw, { schema });
});

describe("OPE-1480 venue-google-amenities probe", () => {
  it("is registered, owned, 72h", () => {
    expect(probe.ownerOpe).toBe("OPE-1480");
    expect(probe.expectedWindowHours).toBe(72);
  });

  it("an unfilled venue from BEFORE arming does not fire it (the floor)", async () => {
    venue("old", "2026-10-10T00:00:00Z", "pid", null, null);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a new venue without a place id owes nothing", async () => {
    venue("n1", "2026-10-19T00:00:00Z", null, null, null);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a new place-id venue left unfilled starts the silence clock at its creation", async () => {
    venue("n2", "2026-10-19T00:00:00Z", "pid2", null, null);
    const at = await probe.lastEvidenceAt(db);
    expect(at?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  it("filled (including Google's {} = none) reads healthy", async () => {
    venue("n3", "2026-10-19T00:00:00Z", "pid3", "{}", '{"freeParkingLot":true}');
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("the seed migration arms exactly this probe", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle/0377_ope1480_venue_google_amenities_probe.sql"),
      "utf8"
    );
    expect(sql).toMatch(
      /INSERT OR IGNORE INTO heartbeat_probes[\s\S]*'venue-google-amenities', unixepoch\(\)/
    );
  });
});
