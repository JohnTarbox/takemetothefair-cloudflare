/**
 * OPE-1057 rework — the `free-text-extract-record` probe.
 *
 * Demand-conditional: a free_text, URL-less, attachment-less submission received
 * after `enabled_at` owes one `submit/free-text-extract` row. The pre-ship
 * specimen (01ad5525) must not redden the probe on arming.
 *
 * Every case states the row counts it read before trusting the verdict.
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
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, classified_sub_intent TEXT,
    parsed_url TEXT, attachment_count INTEGER NOT NULL DEFAULT 0, routed_to_workflow TEXT
  );
  CREATE TABLE workflow_run_steps (
    id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
    inbound_email_id TEXT, step_name TEXT NOT NULL, status TEXT NOT NULL,
    detail TEXT, duration_ms INTEGER, recorded_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "free-text-extract-record")!;

const arm = (at: string | null) =>
  raw
    .prepare(
      `INSERT INTO heartbeat_probes (probe_name, enabled_at, updated_at) VALUES ('free-text-extract-record', ?, 0)`
    )
    .run(at === null ? null : T(at));
const seedEmail = (
  id: string,
  at: string,
  o: { sub?: string | null; url?: string | null; attachments?: number } = {}
) =>
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, classified_sub_intent, parsed_url, attachment_count, routed_to_workflow)
       VALUES (?, ?, ?, ?, ?, 'submit-pipeline')`
    )
    .run(id, T(at), o.sub === undefined ? "free_text" : o.sub, o.url ?? null, o.attachments ?? 0);
const seedStep = (id: string, at: string, stepName = "submit/free-text-extract") =>
  raw
    .prepare(
      `INSERT INTO workflow_run_steps (id, instance_id, workflow_name, step_name, status, recorded_at)
       VALUES (?, 'i', 'inbound-email', ?, 'failed', ?)`
    )
    .run(id, stepName, T(at));
const count = (table: string) =>
  (raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("OPE-1057 free-text-extract-record probe", () => {
  it("is registered with a 24h window", () => {
    expect(probe).toBeTruthy();
    expect(probe.expectedWindowHours).toBe(24);
  });

  it("dormant (enabled_at NULL) reads no evidence", async () => {
    arm(null);
    seedEmail("e1", "2026-10-14T22:44:51Z");
    expect([count("heartbeat_probes"), count("inbound_emails")]).toEqual([1, 1]);
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });

  it("the pre-arming specimen does not redden it: demand before enabled_at is ignored", async () => {
    arm("2026-10-20T00:00:00Z");
    seedEmail("01ad5525", "2026-10-14T22:44:51Z"); // ran on the old code, no row
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([1, 0]);
    const at = await probe.lastEvidenceAt(db);
    // No outstanding demand → healthy NOW.
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000);
  });

  it("a qualifying email after arming with NO row starts the clock at the email", async () => {
    arm("2026-10-20T00:00:00Z");
    seedEmail("e2", "2026-10-22T10:00:00Z");
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([1, 0]);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("a row at or after the demand clears it", async () => {
    arm("2026-10-20T00:00:00Z");
    seedEmail("e2", "2026-10-22T10:00:00Z");
    seedStep("s1", "2026-10-22T10:00:20Z");
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([1, 1]);
    const at = await probe.lastEvidenceAt(db);
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000);
  });

  it("a row under a different step name is not evidence", async () => {
    arm("2026-10-20T00:00:00Z");
    seedEmail("e2", "2026-10-22T10:00:00Z");
    seedStep("s1", "2026-10-22T10:00:20Z", "submit/free-text-gate");
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([1, 1]);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("non-qualifying emails (a URL, an attachment, another sub-intent) owe nothing", async () => {
    arm("2026-10-20T00:00:00Z");
    seedEmail("u", "2026-10-22T10:00:00Z", { url: "https://ex.test/fair" });
    seedEmail("a", "2026-10-22T11:00:00Z", { attachments: 1 });
    seedEmail("s", "2026-10-22T12:00:00Z", { sub: "single_url" });
    expect([count("inbound_emails"), count("workflow_run_steps")]).toEqual([3, 0]);
    const at = await probe.lastEvidenceAt(db);
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000);
  });
});
