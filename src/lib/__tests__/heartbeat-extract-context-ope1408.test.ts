/**
 * OPE-1408 — the extract-context telemetry probe.
 *
 * Demand = a URL-extract row (parsed_url + extraction_method ai/json-ld/thin)
 * received after the probe was armed. Evidence = a row with
 * content_length_chars. The clock starts at the OLDEST unserved demand newer
 * than the newest evidence.
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
    id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, parsed_url TEXT,
    extraction_method TEXT, content_length_chars INTEGER
  );
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "extract-context-telemetry")!;
const URL_ = "https://example.com/event";

const seed = (
  id: string,
  at: string,
  opts: { url?: string | null; method?: string | null; len?: number | null } = {}
) =>
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, parsed_url, extraction_method, content_length_chars) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      id,
      T(at),
      opts.url === undefined ? URL_ : opts.url,
      opts.method === undefined ? "ai" : opts.method,
      opts.len === undefined ? null : opts.len
    );
const count = () => (raw.prepare(`SELECT COUNT(*) n FROM inbound_emails`).get() as { n: number }).n;
const isNow = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 60_000;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  // Armed before every specimen below, as migration 0375 arms it at ship time.
  raw
    .prepare(`INSERT INTO heartbeat_probes (probe_name, enabled_at) VALUES (?, ?)`)
    .run("extract-context-telemetry", T("2026-10-17T00:00:00Z"));
  db = drizzle(raw, { schema });
});

describe("OPE-1408 extract-context-telemetry probe", () => {
  it("is registered, owned, with the measured 240h window", () => {
    expect(probe).toBeTruthy();
    expect(probe.ownerOpe).toBe("OPE-1408");
    expect(probe.expectedWindowHours).toBe(240);
  });

  it("no URL extracts since arming: healthy (no demand)", async () => {
    seed("support", "2026-10-18T00:00:00Z", { method: null }); // a support email quoting a link
    seed("free", "2026-10-18T01:00:00Z", { method: "free-text" });
    expect(count()).toBe(2);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a URL extract that recorded its context is healthy", async () => {
    seed("ok", "2026-10-18T00:00:00Z", { method: "json-ld", len: 4870 });
    expect(count()).toBe(1);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("an empty page (0 chars) is evidence, not a miss", async () => {
    seed("empty", "2026-10-18T00:00:00Z", { method: "thin", len: 0 });
    expect(count()).toBe(1);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("unserved URL extracts start the clock at the OLDEST one — the OPE-1408 shape", async () => {
    seed("served", "2026-10-18T00:00:00Z", { len: 100 });
    seed("miss1", "2026-10-19T00:00:00Z");
    seed("miss2", "2026-10-20T00:00:00Z");
    seed("miss3", "2026-10-21T00:00:00Z", { method: "json-ld" });
    expect(count()).toBe(4);
    // Keying on the newest demand would return 10-21 and keep resetting.
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  it("a later served email clears an earlier lone miss", async () => {
    seed("miss", "2026-10-18T00:00:00Z");
    seed("served", "2026-10-19T00:00:00Z", { len: 2000 });
    expect(count()).toBe(2);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("no parsed_url is not demand, whatever the extraction method", async () => {
    seed("attach", "2026-10-18T00:00:00Z", { url: null, method: "ai" });
    expect(count()).toBe(1);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });
});

describe("OPE-1408 probe — demand floored at enabled_at", () => {
  it("pre-fix NULL rows are not demand (no false RED on ship)", async () => {
    // Prod's newest pre-ship URL extract with a NULL context.
    seed("old", "2026-10-14T00:00:00Z");
    seed("older", "2026-09-29T00:00:00Z", { method: "json-ld" });
    expect(count()).toBe(2);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a dormant/unseeded probe sees no demand", async () => {
    raw.exec(`DELETE FROM heartbeat_probes`);
    seed("miss", "2026-10-18T00:00:00Z");
    expect(count()).toBe(1);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });
});
