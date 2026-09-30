/**
 * OPE-1030 — a failed D1 query must reach `error_logs` WITH the driver error.
 *
 * The error is produced for real, not hand-built: a Drizzle query against a
 * table that does not exist, so the thrown value is the installed drizzle-orm's
 * `DrizzleQueryError` wrapping better-sqlite3's own error on `.cause` — the same
 * shape that stored 227 causeless `Failed query:` rows in prod.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DrizzleQueryError } from "drizzle-orm/errors";
import * as schema from "../../db/schema";
import { captureServerRenderError } from "../capture-render-error";
import { logError } from "../../logger";

const SCHEMA_SQL = `
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'error',
    message TEXT NOT NULL, context TEXT DEFAULT '{}', url TEXT, method TEXT, status_code INTEGER,
    stack_trace TEXT, user_agent TEXT, source TEXT, route TEXT, digest TEXT
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  raw.close();
  vi.restoreAllMocks();
});

/**
 * A genuine driver error, wrapped exactly as production wraps it.
 *
 * better-sqlite3's synchronous Drizzle session does not wrap errors; the ASYNC
 * SQLite session that the D1 driver uses does, in `queryWithCache`
 * (node_modules/drizzle-orm/sqlite-core/session.js:43:
 * `throw new DrizzleQueryError(queryString, params, e)`). So the driver error is
 * real — better-sqlite3 refusing a query against a table that does not exist —
 * and the wrapper is the installed class, applied the way that line applies it.
 */
async function realDbError(): Promise<unknown> {
  const queryString =
    'select count(*) from "blog_posts" where ("blog_posts"."status" = ? and "blog_posts"."tags" LIKE ?)';
  const params = ["PUBLISHED", "%x%"];
  try {
    raw.prepare(queryString).all(...params);
  } catch (driverErr) {
    return new DrizzleQueryError(queryString, params, driverErr as Error);
  }
  throw new Error("expected the query to fail");
}

const lastMessage = () =>
  (
    raw.prepare("SELECT message FROM error_logs ORDER BY rowid DESC LIMIT 1").get() as {
      message: string;
    }
  ).message;

describe("the persisted error_logs.message carries the driver cause", () => {
  it("LANDMARK: the thrown wrapper's own message lacks the driver error", async () => {
    const e = (await realDbError()) as Error & { cause?: Error };
    expect(e.message).toContain("Failed query:");
    expect(e.cause?.message).toMatch(/no such table/);
    expect(e.message).not.toMatch(/no such table/);
  });

  it("main-app logError", async () => {
    await logError(db as never, {
      message: "getVendor failed",
      error: await realDbError(),
      source: "t",
    });
    const m = lastMessage();
    expect(m).toContain("Failed query:");
    expect(m).toContain("params:");
    expect(m).toMatch(/cause: .*no such table: blog_posts/);
  });

  it("server-render capture", async () => {
    await captureServerRenderError(db as never, {
      error: await realDbError(),
      request: { path: "/blog?tag=x", method: "GET" },
      context: { routerKind: "App Router", routeType: "render", routePath: "/blog" },
    });
    const m = lastMessage();
    expect(m).toContain("Failed query:");
    expect(m).toMatch(/cause: .*no such table: blog_posts/);
  });
});
