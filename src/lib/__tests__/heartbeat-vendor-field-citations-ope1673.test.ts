/**
 * OPE-1673 — the vendor-field-citations probe: floored at enabled_at, red from
 * the OLDEST new event holding a vendor fee / deadline with no active citation
 * for that field, and healthy once every such value is cited.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, merged_into TEXT, ingestion_method TEXT,
    vendor_fee_min_cents INTEGER, vendor_fee_max_cents INTEGER, application_deadline INTEGER
  );
  CREATE TABLE event_data_citations (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, field_name TEXT NOT NULL, state TEXT NOT NULL
  );
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "vendor-field-citations")!;
const isNow = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 60_000;

function event(
  id: string,
  at: string,
  v: { min?: number; max?: number; deadline?: string; merged?: string; method?: string }
) {
  raw
    .prepare(
      `INSERT INTO events (id, created_at, merged_into, ingestion_method, vendor_fee_min_cents, vendor_fee_max_cents, application_deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      T(at),
      v.merged ?? null,
      v.method ?? "discovery",
      v.min ?? null,
      v.max ?? null,
      v.deadline ? T(v.deadline) : null
    );
}
const cite = (eventId: string, field: string, state = "active") =>
  raw
    .prepare(
      `INSERT INTO event_data_citations (id, event_id, field_name, state) VALUES (?, ?, ?, ?)`
    )
    .run(`${eventId}-${field}-${state}`, eventId, field, state);

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  raw
    .prepare(`INSERT INTO heartbeat_probes (probe_name, enabled_at) VALUES (?, ?)`)
    .run("vendor-field-citations", T("2026-11-18T00:00:00Z"));
  db = drizzle(raw, { schema });
});

describe("OPE-1673 vendor-field-citations probe", () => {
  it("is registered, owned, 48h", () => {
    expect(probe.ownerOpe).toBe("OPE-1673");
    expect(probe.expectedWindowHours).toBe(48);
  });

  it("an uncited fee from BEFORE arming does not fire it (the floor)", async () => {
    event("old", "2026-11-10T00:00:00Z", { min: 4000 });
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("the oldest uncited new event starts the clock at its creation", async () => {
    event("a", "2026-11-19T00:00:00Z", { min: 4000 });
    event("b", "2026-11-20T00:00:00Z", { deadline: "2026-12-01T12:00:00Z" });
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("each field needs ITS OWN active citation — a fee citation does not cover the deadline", async () => {
    event("c", "2026-11-19T00:00:00Z", { min: 4000, deadline: "2026-12-01T12:00:00Z" });
    cite("c", "vendor_fee_min");
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    cite("c", "application_deadline", "superseded");
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(false);
    cite("c", "application_deadline");
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("OPE-1680 — an uncited fee on a rolled edition (auto_rollover) is in scope and fires it", async () => {
    event("r", "2026-11-19T00:00:00Z", { min: 4000, method: "auto_rollover" });
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    cite("r", "vendor_fee_min");
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("fully cited, tombstones and out-of-scope lanes (admin) read healthy — with a landmark row present", async () => {
    event("d", "2026-11-19T00:00:00Z", { min: 4000, max: 6000 });
    cite("d", "vendor_fee_min");
    cite("d", "vendor_fee_max");
    event("t", "2026-11-19T00:00:00Z", { min: 4000, merged: "d" });
    event("adm", "2026-11-19T00:00:00Z", { min: 4000, method: "admin_manual" });
    event("web", "2026-11-19T00:00:00Z", { min: 4000, method: "web_research" });
    cite("web", "vendor_fee_min");
    event("plain", "2026-11-19T00:00:00Z", {});
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
    // Landmark: the same db goes red when one more uncited row lands.
    event("e", "2026-11-21T00:00:00Z", { max: 6000 });
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-11-21T00:00:00.000Z");
  });

  it("the seed migration arms exactly this probe", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle/0429_ope1673_vendor_field_citations_probe.sql"),
      "utf8"
    );
    expect(sql).toMatch(
      /INSERT INTO heartbeat_probes[\s\S]*'vendor-field-citations',\s*unixepoch\(\)/
    );
  });
});
