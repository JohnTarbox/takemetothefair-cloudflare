import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import { adminActions, events } from "../db/schema";
import type { Database as AppDb } from "../db";
import { expireElapsedEvents, pendingBucket, pendingBucketCounts } from "../pending-buckets";

const NOW = new Date("2026-11-09T15:00:00Z");
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;
let db: AppDb;

function event(id: string, status: string, start: number | null, end: number | null) {
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, status, start_date, end_date) VALUES (?,?,?,?,?,?)"
    )
    .run(id, id, id, status, start, end);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(events));
  raw.exec(ddlFor(adminActions));
  db = drizzle(raw, { schema }) as unknown as AppDb;
  event("old", "PENDING", sec("2025-09-06T12:00:00Z"), sec("2025-09-07T12:00:00Z"));
  event("today", "PENDING", sec("2026-11-09T12:00:00Z"), sec("2026-11-09T12:00:00Z"));
  event("start-only-past", "PENDING", sec("2026-01-01T12:00:00Z"), null);
  event("future", "PENDING", sec("2026-12-01T12:00:00Z"), sec("2026-12-02T12:00:00Z"));
  event("nodate", "PENDING", null, null);
  event("approved-past", "APPROVED", sec("2025-01-01T12:00:00Z"), sec("2025-01-02T12:00:00Z"));
});

describe("pendingBucket", () => {
  it("keeps an event ending today in upcoming", () => {
    expect(pendingBucket("2026-11-09T12:00:00Z", "2026-11-09T12:00:00Z", NOW)).toBe("upcoming");
    expect(pendingBucket("2026-11-08T12:00:00Z", "2026-11-08T12:00:00Z", NOW)).toBe("ended");
  });

  it("falls back to the start date, and reports a row with neither date", () => {
    expect(pendingBucket("2026-01-01T12:00:00Z", null, NOW)).toBe("ended");
    expect(pendingBucket(null, null, NOW)).toBe("no_date");
  });
});

describe("pendingBucketCounts", () => {
  it("agrees with pendingBucket and counts only PENDING rows", async () => {
    expect(await pendingBucketCounts(db, NOW)).toEqual({ upcoming: 2, ended: 2, no_date: 1 });
  });
});

describe("expireElapsedEvents", () => {
  const status = (id: string) =>
    (raw.prepare("SELECT status FROM events WHERE id = ?").get(id) as { status: string }).status;

  it("rejects only ended PENDING rows and audits each one", async () => {
    const { expired } = await expireElapsedEvents(
      db,
      ["old", "start-only-past", "future", "nodate", "approved-past"],
      "admin-1",
      NOW
    );
    expect(expired.sort()).toEqual(["old", "start-only-past"]);
    expect(status("old")).toBe("REJECTED");
    expect(status("future")).toBe("PENDING");
    expect(status("nodate")).toBe("PENDING");
    expect(status("approved-past")).toBe("APPROVED");
    const audit = raw.prepare("SELECT target_id, payload_json FROM admin_actions").all() as {
      target_id: string;
      payload_json: string;
    }[];
    expect(audit.map((a) => a.target_id).sort()).toEqual(["old", "start-only-past"]);
    expect(JSON.parse(audit[0].payload_json).reason).toBe("elapsed_unreviewed");
  });
});
