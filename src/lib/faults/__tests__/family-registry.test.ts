import { describe, expect, it } from "vitest";
import { FAULT_FAMILIES, classifyFault, classifySignature } from "@/lib/faults/family-registry";
import { normalizeErrorClass } from "@/lib/faults/signature";

describe("classifyFault — FAM-D1-PARAMCAP (the acceptance case)", () => {
  it("auto-classifies a bare `too many sql variables` class with NO human input", () => {
    const c = classifyFault({ errorClass: "too many sql variables" });
    expect(c).toEqual({
      disposition: "auto-classified",
      familyKey: "FAM-D1-PARAMCAP",
      rootCauseClass: "param-cap",
      fixPattern: "chunk ≤90",
      guardStatus: "missing",
    });
  });

  it("auto-classifies a realistic full message once normalized", () => {
    // The classifier runs on the SAME normalized surface signature.ts produces.
    const errorClass = normalizeErrorClass("D1_ERROR: too many SQL variables at offset 5");
    const c = classifyFault({ errorClass });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-D1-PARAMCAP");
    expect(c.rootCauseClass).toBe("param-cap");
    expect(c.fixPattern).toBe("chunk ≤90");
    expect(c.guardStatus).toBe("missing");
  });

  it("also matches the `too many bound parameters` variant", () => {
    const c = classifyFault({ errorClass: "too many bound parameters" });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.rootCauseClass).toBe("param-cap");
  });
});

describe("classifyFault — other families", () => {
  it("classifies a column-cap message as column-cap with guard present", () => {
    const c = classifyFault({ errorClass: "too many columns on events" });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-D1-COLCAP");
    expect(c.rootCauseClass).toBe("column-cap");
    expect(c.guardStatus).toBe("present");
    expect(c.guardRef).toBe("check-d1-100col-joins.ts");
  });

  it("classifies an empty-collection render throw", () => {
    const errorClass = normalizeErrorClass(
      "TypeError: Cannot read properties of undefined (reading 'name')"
    );
    const c = classifyFault({ errorClass });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-EMPTY-COLLECTION");
    expect(c.rootCauseClass).toBe("empty-collection-render");
    expect(c.guardStatus).toBe("missing");
  });

  it("classifies a chunk-load message as stale-deploy-chunk with n/a guard", () => {
    const c = classifyFault({ errorClass: "chunkloaderror loading chunk failed" });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-CHUNK-STALE");
    expect(c.rootCauseClass).toBe("stale-deploy-chunk");
    expect(c.guardStatus).toBe("n/a");
  });
});

describe("classifyFault — unclassified", () => {
  it("marks a nonsense error class unclassified", () => {
    expect(classifyFault({ errorClass: "totally unknown gibberish" })).toEqual({
      disposition: "unclassified",
    });
  });

  it("never throws on empty/nullish error class → unclassified", () => {
    expect(classifyFault({ errorClass: "" })).toEqual({ disposition: "unclassified" });
    expect(classifyFault({ errorClass: null })).toEqual({ disposition: "unclassified" });
    expect(classifyFault({ errorClass: undefined })).toEqual({ disposition: "unclassified" });
    expect(classifyFault({ errorClass: "   " })).toEqual({ disposition: "unclassified" });
  });
});

describe("classifyFault — precedence (first-match-wins)", () => {
  it("resolves a message with BOTH a param-cap and a generic token to param-cap", () => {
    // Contains the empty-collection `cannot read property` token AND the param-cap
    // token — param-cap is the more specific family and comes first.
    const c = classifyFault({
      errorClass: "too many sql variables; cannot read property foo of undefined",
    });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-D1-PARAMCAP");
    expect(c.rootCauseClass).toBe("param-cap");
  });

  it("is case-insensitive", () => {
    const c = classifyFault({ errorClass: "TOO MANY SQL VARIABLES" });
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-D1-PARAMCAP");
  });
});

describe("classifySignature", () => {
  it("recovers route + errorClass from `route#errorClass` and classifies", () => {
    const c = classifySignature("/admin/blog#too many sql variables");
    expect(c.disposition).toBe("auto-classified");
    if (c.disposition !== "auto-classified") throw new Error("unreachable");
    expect(c.familyKey).toBe("FAM-D1-PARAMCAP");
    expect(c.rootCauseClass).toBe("param-cap");
    expect(c.fixPattern).toBe("chunk ≤90");
    expect(c.guardStatus).toBe("missing");
  });

  it("marks a nonsense signature unclassified", () => {
    expect(classifySignature("/foo#totally unknown gibberish")).toEqual({
      disposition: "unclassified",
    });
  });

  it("never throws on empty/nullish signature", () => {
    expect(classifySignature("")).toEqual({ disposition: "unclassified" });
    expect(classifySignature(null)).toEqual({ disposition: "unclassified" });
    expect(classifySignature(undefined)).toEqual({ disposition: "unclassified" });
  });

  it("classifies on the whole string when there is no `#`", () => {
    const c = classifySignature("too many sql variables");
    expect(c.disposition).toBe("auto-classified");
  });
});

describe("FAULT_FAMILIES registry shape", () => {
  it("is precedence-ordered with param-cap first and unique keys", () => {
    expect(FAULT_FAMILIES[0].key).toBe("FAM-D1-PARAMCAP");
    const keys = FAULT_FAMILIES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
