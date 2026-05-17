/**
 * Unit tests for the MCP-side logError helper.
 *
 * The logger is best-effort: it must never throw, must call console at the
 * right level, must merge `sessionId` into `context`, must accept either a
 * raw D1Database binding or a wrapped Drizzle Db, and must silently no-op
 * when given null/undefined.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { logError } from "../src/logger.js";

function mockD1Like(opts: { insertThrows?: boolean } = {}) {
  // We intercept at the Drizzle-Db level by faking an object that has
  // `.insert(table).values(row)`. The logger heuristic-detects this shape
  // and skips the getDb wrapping.
  const captured: Array<Record<string, unknown>> = [];
  const valuesFn = vi.fn(async (row: Record<string, unknown>) => {
    if (opts.insertThrows) throw new Error("simulated D1 failure");
    captured.push(row);
  });
  const insertFn = vi.fn(() => ({ values: valuesFn }));
  const db = { insert: insertFn } as unknown as Parameters<typeof logError>[0];
  return { db, captured, insertFn, valuesFn };
}

describe("logError — best-effort semantics", () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("no-ops cleanly when given null db", async () => {
    await expect(logError(null, { message: "x" })).resolves.toBeUndefined();
    expect(consoleErrSpy).toHaveBeenCalled();
  });

  it("no-ops cleanly when given undefined db", async () => {
    await expect(logError(undefined, { message: "x" })).resolves.toBeUndefined();
  });

  it("does not throw when D1 insert itself throws", async () => {
    const { db } = mockD1Like({ insertThrows: true });
    await expect(logError(db, { message: "x" })).resolves.toBeUndefined();
    // The secondary console.error from the inner catch should fire.
    // (Plus the primary log of the original message.)
    expect(consoleErrSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("logError — row shape", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a row with id, timestamp, level, message, source", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "hello", level: "warn", source: "mcp:test" });
    expect(captured).toHaveLength(1);
    const row = captured[0];
    expect(typeof row.id).toBe("string");
    expect((row.id as string).length).toBeGreaterThan(0);
    expect(row.timestamp).toBeInstanceOf(Date);
    expect(row.level).toBe("warn");
    expect(row.message).toBe("hello");
    expect(row.source).toBe("mcp:test");
  });

  it("merges sessionId into the context JSON blob (not a top-level column)", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, {
      message: "with session",
      sessionId: "abc-123",
      context: { foo: "bar" },
    });
    const row = captured[0];
    expect(row.context).toBeTypeOf("string");
    const parsed = JSON.parse(row.context as string);
    expect(parsed).toEqual({ foo: "bar", sessionId: "abc-123" });
  });

  it("stamps sessionId even when no other context is provided", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "no ctx", sessionId: "s-1" });
    const parsed = JSON.parse(captured[0].context as string);
    expect(parsed).toEqual({ sessionId: "s-1" });
  });

  it("defaults context to empty object string when neither is provided", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "bare" });
    expect(captured[0].context).toBe("{}");
  });

  it("appends error.message to the message field when error is Error", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "fetch failed", error: new Error("ECONNREFUSED") });
    expect(captured[0].message).toBe("fetch failed: ECONNREFUSED");
  });

  it("captures Error.stack into stackTrace", async () => {
    const { db, captured } = mockD1Like();
    const err = new Error("boom");
    await logError(db, { message: "x", error: err });
    expect(captured[0].stackTrace).toBe(err.stack);
  });

  it("stringifies non-Error error values into stackTrace and message", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "x", error: "stringy" });
    expect(captured[0].stackTrace).toBe("stringy");
    expect(captured[0].message).toBe("x: stringy");
  });

  it("defaults level to 'error'", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "x" });
    expect(captured[0].level).toBe("error");
  });

  it("preserves statusCode in its own column", async () => {
    const { db, captured } = mockD1Like();
    await logError(db, { message: "x", statusCode: 502 });
    expect(captured[0].statusCode).toBe(502);
  });
});

describe("logError — console output by level", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default level 'error' routes to console.error", async () => {
    await logError(null, { message: "x" });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("level 'warn' routes to console.warn", async () => {
    await logError(null, { message: "x", level: "warn" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("level 'info' routes to console.log", async () => {
    await logError(null, { message: "x", level: "info" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
