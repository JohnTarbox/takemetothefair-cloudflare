/**
 * OPE-1608 — the `promoter-onboarding` probe: green on a recent pass, and red
 * as soon as a request is overdue for a draft or a send.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE promoter_onboarding_requests (
    id TEXT PRIMARY KEY, draft_id TEXT, target_at INTEGER, replied_at INTEGER,
    closed_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT NOT NULL, source TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const probe = HEARTBEAT_PROBES.find((p) => p.name === "promoter-onboarding")!;
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

const request = (o: {
  id?: string;
  draft?: string | null;
  target?: number | null;
  replied?: number | null;
  closed?: number | null;
  age: number;
}) =>
  raw
    .prepare(`INSERT INTO promoter_onboarding_requests VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      o.id ?? "r1",
      o.draft ?? null,
      o.target ?? null,
      o.replied ?? null,
      o.closed ?? null,
      now() - o.age
    );

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(`INSERT INTO error_logs VALUES ('e1', ?, 'info', 'mcp:inbound:promoter-onboarding')`)
    .run(now() - 300);
});

describe("OPE-1608 — promoter-onboarding probe", () => {
  it("reports the last pass when nothing is overdue, with one request examined", async () => {
    request({ age: 600 });
    const at = await probe.lastEvidenceAt(db);
    expect(at!.getTime()).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it("RED when a request has no draft after two hours", async () => {
    request({ age: 2 * HOUR + 60 });
    expect((await probe.lastEvidenceAt(db))!.getTime()).toBe(0);
  });

  it("RED when a draft is past its deadline unsent", async () => {
    request({ age: 30 * HOUR, draft: "d1", target: now() - 60 });
    expect((await probe.lastEvidenceAt(db))!.getTime()).toBe(0);
  });

  it("not red for a closed request or one already replied to", async () => {
    request({ id: "r1", age: 30 * HOUR, closed: now() });
    request({ id: "r2", age: 30 * HOUR, draft: "d1", target: now() - 60, replied: now() - 90 });
    expect((await probe.lastEvidenceAt(db))!.getTime()).toBeGreaterThan(0);
  });

  it("is null when the pass has never run", async () => {
    raw.exec("DELETE FROM error_logs");
    expect(await probe.lastEvidenceAt(db)).toBeNull();
  });
});
