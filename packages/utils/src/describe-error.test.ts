/**
 * OPE-1030 — `describeError` keeps the driver error that Drizzle hides on `.cause`.
 *
 * The fixture is the REAL wrapper, not a hand-built lookalike: DrizzleQueryError
 * from the installed drizzle-orm, carrying a D1-shaped error as its cause.
 */
import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describeError, errorCauseMessages } from "./describe-error";

const D1_CAUSE = "D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR";

function specimen(paramsText = `PUBLISHED,%"-2026 UNION ALL SELECT 'x'--"%`) {
  return new DrizzleQueryError(
    'select count(*) from "blog_posts" where ("blog_posts"."status" = ? and "blog_posts"."tags" LIKE ?)',
    paramsText.split(","),
    new Error(D1_CAUSE)
  );
}

describe("describeError", () => {
  it("LANDMARK: the real Drizzle wrapper's message does NOT contain the D1 error", () => {
    // Without this the tests below could pass against a wrapper that already
    // included its cause, and prove nothing about the defect.
    expect(specimen().message).toContain("Failed query:");
    expect(specimen().message).not.toContain("D1_ERROR");
  });

  it("appends the cause after the SQL and params", () => {
    const s = describeError(specimen());
    expect(s).toContain("Failed query:");
    expect(s).toContain("params:");
    expect(s).toContain(`cause: ${D1_CAUSE}`);
  });

  it("keeps the cause whole when truncating a long wrapper", () => {
    const long = specimen(Array.from({ length: 600 }, (_, i) => `cpi:key:${i}`).join(","));
    const s = describeError(long, 400);
    expect(s.length).toBeLessThanOrEqual(400);
    expect(s.endsWith(`cause: ${D1_CAUSE}`)).toBe(true);
  });

  it("walks nested causes, skips one already in the message, and survives a cycle", () => {
    const root = new Error("SQLITE_BUSY");
    const mid = new Error("D1_ERROR: database is locked", { cause: root });
    const top = new Error("outer failed: SQLITE_BUSY", { cause: mid });
    expect(errorCauseMessages(top)).toEqual(["D1_ERROR: database is locked", "SQLITE_BUSY"]);
    expect(describeError(top)).toBe(
      "outer failed: SQLITE_BUSY\ncause: D1_ERROR: database is locked"
    );

    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeError(a)).toBe("a\ncause: b");
  });

  it("leaves a plain error, and a non-error, unchanged", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("just a string")).toBe("just a string");
  });
});
