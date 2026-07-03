/**
 * OPE-80 — captureServerRenderError core.
 *
 * Proves the three hard invariants against better-sqlite3:
 *   (a) a real render error → ONE source='server-render' row carrying the REAL
 *       message + digest + route (not the client's redacted digest string).
 *   (b) a null / plain-string error → still writes a row, never throws.
 *   (c) a throwing db → captureServerRenderError does NOT throw (defensive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { captureServerRenderError } from "../capture-render-error";

// Minimal error_logs table mirroring the OPE-80 columns the core writes.
const SCHEMA_SQL = `
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'error',
    message TEXT NOT NULL,
    context TEXT DEFAULT '{}',
    url TEXT,
    method TEXT,
    status_code INTEGER,
    stack_trace TEXT,
    user_agent TEXT,
    source TEXT,
    route TEXT,
    digest TEXT
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function allRows() {
  return raw.prepare(`SELECT * FROM error_logs`).all() as Array<{
    source: string;
    level: string;
    message: string;
    digest: string | null;
    route: string | null;
    method: string | null;
    url: string | null;
    stack_trace: string | null;
    context: string | null;
  }>;
}

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

describe("captureServerRenderError", () => {
  it("(a) real render error → one source='server-render' row with real message + digest + route", async () => {
    await captureServerRenderError(db as never, {
      error: {
        message: "D1_ERROR: too many SQL variables",
        stack: "Error: D1_ERROR: too many SQL variables\n    at query (/app/db.js:1:1)",
        digest: "4051271804",
      },
      request: { path: "/admin/blog", method: "GET" },
      context: { routerKind: "App Router", routeType: "render", routePath: "/admin/blog" },
    });

    const rows = allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source).toBe("server-render");
    expect(row.level).toBe("error");
    // The REAL message, not the redacted client digest string.
    expect(row.message).toBe("D1_ERROR: too many SQL variables");
    expect(row.digest).toBe("4051271804");
    expect(row.route).toBe("/admin/blog");
    expect(row.method).toBe("GET");
    // url mirrors route so existing url-based queries also find it.
    expect(row.url).toBe("/admin/blog");
    expect(row.stack_trace).toContain("D1_ERROR");
    expect(JSON.parse(row.context ?? "{}")).toMatchObject({
      routerKind: "App Router",
      routeType: "render",
      routePath: "/admin/blog",
    });
  });

  it("falls back to context.routePath for route when request.path is absent", async () => {
    await captureServerRenderError(db as never, {
      error: new Error("boom"),
      context: { routePath: "/events/[slug]", routerKind: "App Router", routeType: "render" },
    });
    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe("/events/[slug]");
    expect(rows[0].message).toBe("boom");
  });

  it("(b) null / plain-string error → still writes a row, no throw, no digest", async () => {
    await expect(
      captureServerRenderError(db as never, {
        error: null,
        request: { path: "/", method: "GET" },
      })
    ).resolves.toBeUndefined();

    await expect(
      captureServerRenderError(db as never, {
        error: "kaboom string",
        request: { path: "/x", method: "POST" },
      })
    ).resolves.toBeUndefined();

    const rows = allRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toBe("null");
    expect(rows[0].digest).toBeNull();
    expect(rows[0].stack_trace).toBeNull();
    expect(rows[1].message).toBe("kaboom string");
    expect(rows[1].route).toBe("/x");
    expect(rows[1].method).toBe("POST");
  });

  it("(c) throwing db → does NOT throw (defensive proof)", async () => {
    const throwingDb = {
      insert() {
        throw new Error("D1 unavailable");
      },
    } as never;

    await expect(
      captureServerRenderError(throwingDb, {
        error: new Error("render failed"),
        request: { path: "/admin", method: "GET" },
      })
    ).resolves.toBeUndefined();
  });

  it("null db → no-op, no throw", async () => {
    await expect(
      captureServerRenderError(null, {
        error: new Error("x"),
        request: { path: "/y", method: "GET" },
      })
    ).resolves.toBeUndefined();
  });

  it("truncates a pathologically long message", async () => {
    const huge = "x".repeat(10_000);
    await captureServerRenderError(db as never, {
      error: { message: huge },
      request: { path: "/big", method: "GET" },
    });
    const row = allRows()[0];
    expect(row.message.length).toBeLessThan(huge.length);
    expect(row.message.endsWith("…[truncated]")).toBe(true);
  });
});
