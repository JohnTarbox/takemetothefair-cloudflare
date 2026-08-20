/**
 * OPE-366 — the D1 LIKE-pattern cap, and why this is a SOURCE-level test.
 *
 * D1 throws `LIKE or GLOB pattern too complex` once a LIKE pattern exceeds 50
 * characters. Local SQLite's cap is 50,000 — a thousand times higher — so a
 * behavioural test of the old code passes locally and fails in production.
 * That is exactly how 293 errors accumulated across two live endpoints for
 * three weeks while CI stayed green.
 *
 * Behaviour cannot catch this. What can is asserting that the two endpoints
 * never build a LIKE pattern from user input again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { containsCI } from "@/lib/db/contains-ci";

function source(rel: string): string {
  return readFileSync(`${process.cwd()}/src/${rel}`, "utf8");
}

/** Strip comments — both files EXPLAIN the LIKE trap, and the explanation
 *  must not read as the violation it warns about. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("containsCI", () => {
  it("emits instr(), never LIKE", () => {
    const q = containsCI({ name: "x" } as never, "Fryeburg");
    expect(JSON.stringify(q)).toContain("instr");
    expect(JSON.stringify(q)).not.toMatch(/\bLIKE\b/i);
  });

  it("lowercases the needle so matching is case-insensitive on both sides", () => {
    expect(JSON.stringify(containsCI({ name: "x" } as never, "FRYEBURG"))).toContain("fryeburg");
  });

  it("treats % and _ as literal, not wildcards", () => {
    // The LIKE form needed escaping and got `100%_off` wrong; instr does not.
    const q = containsCI({ name: "x" } as never, "100%_off");
    expect(JSON.stringify(q)).toContain("100%_off");
  });
});

describe("the two endpoints that carried the bug", () => {
  const ENDPOINTS = ["app/api/search/route.ts", "app/api/vendor/self-reported-events/route.ts"];

  for (const rel of ENDPOINTS) {
    it(`${rel} builds no LIKE pattern from user input`, () => {
      const src = code(source(rel));
      expect(src.length).toBeGreaterThan(500); // the file was actually read
      expect(src).toContain("containsCI");
      expect(src).not.toMatch(/\bLIKE\b/i);
    });

    it(`${rel} wraps nothing in % wildcards`, () => {
      // `%${term}%` is the shape that builds an over-long pattern.
      const src = code(source(rel));
      expect(src).not.toMatch(/`%\$\{/);
      expect(src).not.toMatch(/"%"\s*\+/);
    });
  }
});
