/**
 * OPE-907 — `logError` (src/logger.ts) against a REAL local D1 inside workerd.
 *
 * The Node suite can only hand `logError` a fake: better-sqlite3 behind a
 * hand-rolled shim, or an object whose `prepare` is missing (hence the
 * "this.client.prepare is not a function" lines in the Node run's stderr). So
 * nothing there proves the drizzle D1 driver's statement is one D1 accepts, that
 * the `errorLogs` drizzle table matches the table the `drizzle/` migrations
 * actually build, or that `timestamp` lands as SECONDS (the column is
 * `mode: "timestamp"`; a millisecond value would sort every row 1000× into the
 * future and fall out of every `/admin/logs` window).
 *
 * Here the D1 binding is miniflare's, migrated from the repo's own migration
 * files, and the row is read back with raw SQL — not through the same drizzle
 * table object that wrote it, which would agree with itself whatever the
 * migrations say.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { logError } from "../src/logger.js";
import { getDb } from "../src/db.js";
import type { WorkerdTestEnv } from "./env.js";

const { DB, TEST_MIGRATIONS } = env as unknown as WorkerdTestEnv;

beforeAll(async () => {
  // Every file in `drizzle/`, in order — recorded in `d1_migrations`, so a
  // re-run against an already-migrated database is a no-op.
  await applyD1Migrations(DB, TEST_MIGRATIONS);
});

interface ErrorLogRow {
  id: string;
  timestamp: number;
  level: string;
  message: string;
  context: string;
  status_code: number | null;
  stack_trace: string | null;
  source: string | null;
  route: string | null;
  digest: string | null;
}

async function rowsFor(source: string): Promise<ErrorLogRow[]> {
  const { results } = await DB.prepare(
    "SELECT id, timestamp, level, message, context, status_code, stack_trace, source, route, digest FROM error_logs WHERE source = ?"
  )
    .bind(source)
    .all<ErrorLogRow>();
  return results;
}

describe("OPE-907 workerd — logError writes error_logs through a real D1 binding", () => {
  it("the migrated D1 has the error_logs table (the migrations really ran)", async () => {
    const table = await DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'error_logs'"
    ).first<{ name: string }>();
    expect(table?.name).toBe("error_logs");
  });

  it("a raw D1Database binding: one row, every field in the column D1 stores it in", async () => {
    const source = "mcp:workerd-test:raw-binding";
    const before = Math.floor(Date.now() / 1000);

    await logError(DB, {
      message: "upstream refused",
      error: new Error("kaput"),
      source,
      level: "warn",
      statusCode: 502,
      context: { attempt: 2 },
      sessionId: "session-907",
    });

    const rows = await rowsFor(source);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.message).toBe("upstream refused: kaput");
    expect(row.level).toBe("warn");
    expect(row.status_code).toBe(502);
    expect(JSON.parse(row.context)).toEqual({ attempt: 2, sessionId: "session-907" });
    expect(row.stack_trace).toContain("kaput");
    // SECONDS, not milliseconds — a ms value is ~1.7e12, far past this bound.
    expect(typeof row.timestamp).toBe("number");
    expect(row.timestamp).toBeGreaterThanOrEqual(before - 5);
    expect(row.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5);
    // Columns added by later migrations (0147) exist and stay NULL for MCP writes.
    expect(row.route).toBeNull();
    expect(row.digest).toBeNull();
  });

  it("an already-wrapped drizzle Db is passed through, not re-wrapped", async () => {
    const source = "mcp:workerd-test:drizzle-db";

    await logError(getDb(DB), { message: "no error object", source });

    const rows = await rowsFor(source);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("no error object");
    expect(rows[0].level).toBe("error");
    expect(rows[0].context).toBe("{}");
    expect(rows[0].stack_trace).toBeNull();
  });
});
