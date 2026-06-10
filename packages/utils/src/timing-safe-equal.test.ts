import { describe, it, expect } from "vitest";
import { timingSafeEqualString } from "./timing-safe-equal";

describe("timingSafeEqualString", () => {
  it("returns true for identical strings", async () => {
    expect(await timingSafeEqualString("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for differing strings of equal length", async () => {
    expect(await timingSafeEqualString("aaaaaaaa", "aaaaaaab")).toBe(false);
  });

  it("returns false for differing-length strings (no throw on length mismatch)", async () => {
    expect(await timingSafeEqualString("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("returns false when the presented value is empty", async () => {
    expect(await timingSafeEqualString("", "expected")).toBe(false);
  });

  it("returns false when either side is undefined or null", async () => {
    expect(await timingSafeEqualString(undefined, "expected")).toBe(false);
    expect(await timingSafeEqualString("presented", undefined)).toBe(false);
    expect(await timingSafeEqualString(null, null)).toBe(false);
  });

  it("is sensitive to a single trailing character", async () => {
    expect(await timingSafeEqualString("token", "token ")).toBe(false);
  });

  it("handles unicode / multibyte content", async () => {
    expect(await timingSafeEqualString("café-x", "café-x")).toBe(true);
    expect(await timingSafeEqualString("café-x", "cafe-x")).toBe(false);
  });
});
