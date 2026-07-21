import { describe, expect, it } from "vitest";
import {
  classifyNoise,
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

/**
 * OPE-251 — route-aware third-party denylist.
 *
 * The ledger kept re-litigating shapes a human had already closed, because
 * signatures are route-scoped: closing `unknown#object not found…` as noise did
 * nothing when the same shape reappeared on a /blog route.
 *
 * The carve-out is the part that must never regress. `/register#script error.`
 * was NOT noise — it was the CORS-masked registration-blocking Turnstile throw
 * (OPE-173). A flat denylist would have silenced the most important client
 * fault we have had.
 */
describe("classifyNoise — route-aware third-party denylist (OPE-251)", () => {
  it("suppresses the embed-widget shape that re-proposed on /blog", () => {
    const v = classifyNoise({
      message: "Object not found matching id:, methodName:update, paramCount:",
      route: "/blog/your-complete-guide-to-maine-fairs-and-festivals-in-2026",
    });
    expect(v.noise).toBe(true);
    expect(v.reason).toBe("third-party");
  });

  it("does NOT suppress the same shape on /register (the OPE-173 carve-out)", () => {
    const v = classifyNoise({ message: "Script error.", route: "/register" });
    expect(v.noise).toBe(false);
  });

  it("keeps the carve-out on every conversion/auth route", () => {
    for (const route of ["/login", "/signup", "/claim/abc", "/verify", "/checkout"]) {
      expect(classifyNoise({ message: "Script error.", route }).noise).toBe(false);
    }
  });

  it("suppresses Script error. on an ordinary route", () => {
    expect(classifyNoise({ message: "Script error.", route: "/events/topsham-fair" }).noise).toBe(
      true
    );
  });

  it("suppresses minified third-party null-derefs", () => {
    expect(
      classifyNoise({
        message: "TypeError: null is not an object (evaluating 'b.parentNode')",
        route: "/events/x",
      }).noise
    ).toBe(true);
  });

  it("still suppresses ALWAYS-noise everywhere, including /register", () => {
    // Chunk churn is un-actionable even on a conversion route — the carve-out
    // is only for third-party shapes that can mask a real fault.
    const v = classifyNoise({ message: "Loading chunk 42 failed", route: "/register" });
    expect(v.noise).toBe(true);
    expect(v.reason).toBe("always");
  });

  it("treats an unknown route as non-exempt (suppressible)", () => {
    expect(classifyNoise({ message: "Script error.", route: null }).noise).toBe(true);
  });

  it("does not suppress a genuine app error that merely mentions an object", () => {
    expect(
      classifyNoise({ message: "D1_ERROR: no such column: foo", route: "/events/x" }).noise
    ).toBe(false);
  });

  it("reports which pattern matched, for the audit log and counter", () => {
    expect(classifyNoise({ message: "Script error.", route: "/blog/x" }).matched).toBe(
      "script error."
    );
  });
});
