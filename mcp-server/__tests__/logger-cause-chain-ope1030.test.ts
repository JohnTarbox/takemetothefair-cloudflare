/**
 * OPE-1030 — the MCP Worker's logError keeps the D1 error Drizzle hides on
 * `.cause`. Same genuine-driver-error fixture as the main-app test: a real
 * better-sqlite3 refusal, wrapped as the async SQLite session wraps it
 * (drizzle-orm/sqlite-core/session.js:43).
 */
import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createTestDb } from "./setup-db.js";
import { logError } from "../src/logger.js";

describe("mcp logError", () => {
  it("persists the driver cause alongside the Failed query wrapper", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, raw } = createTestDb();
    const q =
      'update "stale_red_signals_missing" set "resolved_at" = ? where "ref_key" not in (?, ?)';
    let wrapped: unknown;
    try {
      raw.prepare(q).run(1, "a", "b");
    } catch (e) {
      wrapped = new DrizzleQueryError(q, [1, "a", "b"], e as Error);
    }
    expect((wrapped as Error).message).not.toMatch(/no such table/); // landmark

    await logError(db as never, {
      source: "cpi:test",
      message: "persistence failed",
      error: wrapped,
    });
    const row = raw.prepare("SELECT message FROM error_logs ORDER BY rowid DESC LIMIT 1").get() as {
      message: string;
    };
    expect(row.message).toContain("Failed query:");
    expect(row.message).toMatch(/cause: .*no such table: stale_red_signals_missing/);
    vi.restoreAllMocks();
  });
});
