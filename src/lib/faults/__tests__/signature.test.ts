import { describe, expect, it } from "vitest";
import {
  computeSignature,
  faultSigToken,
  isNoise,
  normalizeErrorClass,
} from "@/lib/faults/signature";

describe("normalizeErrorClass", () => {
  it("returns '' for empty/nullish input", () => {
    expect(normalizeErrorClass("")).toBe("");
    expect(normalizeErrorClass(null)).toBe("");
    expect(normalizeErrorClass(undefined)).toBe("");
  });

  it("collapses the D1 too-many-variables example to a durable class", () => {
    expect(normalizeErrorClass("D1_ERROR: too many SQL variables at offset 123")).toBe(
      "d1_error: too many sql variables at offset"
    );
  });

  it("is stable across occurrences that differ only in volatile tokens", () => {
    const a = normalizeErrorClass("D1_ERROR: too many SQL variables at offset 123");
    const b = normalizeErrorClass("D1_ERROR: too many SQL variables at offset 999999");
    expect(a).toBe(b);
  });

  it("strips numbers, uuids, hex ids, and quoted literals but keeps embedded digits", () => {
    // Standalone numbers gone, but d1's embedded 1 survives.
    expect(normalizeErrorClass("d1_error code 42")).toBe("d1_error code");
    // UUID stripped.
    expect(
      normalizeErrorClass("record 550e8400-e29b-41d4-a716-446655440000 not found").replace(
        /\s+/g,
        " "
      )
    ).toBe("record not found");
    // Hex id stripped.
    expect(normalizeErrorClass("failed at 0xdeadbeef in handler")).toBe("failed at in handler");
    // Quoted literal (a volatile slug) stripped so two rows collapse.
    expect(normalizeErrorClass('event "summer-fair-2026" missing')).toBe(
      normalizeErrorClass('event "winter-fair-2027" missing')
    );
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeErrorClass("  Some   Mixed\tCASE  ")).toBe("some mixed case");
  });
});

describe("isNoise", () => {
  it("catches denylist entries in the raw message", () => {
    expect(isNoise("Loading chunk 45 failed")).toBe(true);
    expect(isNoise("ChunkLoadError: something")).toBe(true);
    expect(isNoise("TypeError: Failed to fetch dynamically imported module: /x.js")).toBe(true);
    expect(isNoise("NetworkError when attempting to fetch resource.")).toBe(true);
    expect(isNoise("Load failed")).toBe(true);
    expect(isNoise("The operation was aborted")).toBe(true);
    expect(isNoise("Hydration failed because the server rendered HTML")).toBe(true);
    expect(isNoise("URI malformed")).toBe(true);
  });

  it("is not noise for actionable messages or nullish input", () => {
    expect(isNoise("D1_ERROR: too many SQL variables at offset 123")).toBe(false);
    expect(isNoise("Cannot read properties of undefined (reading 'name')")).toBe(false);
    expect(isNoise(null)).toBe(false);
    expect(isNoise(undefined)).toBe(false);
    expect(isNoise("")).toBe(false);
  });
});

describe("computeSignature", () => {
  it("is `route#error-class` from the normalized message", () => {
    expect(
      computeSignature({
        route: "/events/[slug]",
        message: "D1_ERROR: too many SQL variables at offset 123",
        digest: "abc123",
      })
    ).toBe("/events/[slug]#d1_error: too many sql variables at offset");
  });

  it("falls back to digest when the message normalizes to empty", () => {
    expect(computeSignature({ route: "/x", message: "", digest: "deadbeef" })).toBe(
      "/x#digest:deadbeef"
    );
    expect(computeSignature({ route: "/x", message: null, digest: null })).toBe("/x#digest:none");
  });

  it("defaults route to 'unknown' when absent", () => {
    expect(computeSignature({ route: null, message: "Boom happened", digest: null })).toBe(
      "unknown#boom happened"
    );
  });

  it("is deterministic + stable across occurrences of the same fault", () => {
    const base = { route: "/a", digest: "d" };
    expect(computeSignature({ ...base, message: "failed for id 1" })).toBe(
      computeSignature({ ...base, message: "failed for id 2" })
    );
  });
});

describe("faultSigToken", () => {
  it("is `fault-sig:<signature>`", () => {
    expect(faultSigToken("/x#boom")).toBe("fault-sig:/x#boom");
  });
});
