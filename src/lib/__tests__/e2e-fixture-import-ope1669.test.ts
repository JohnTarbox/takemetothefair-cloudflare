/**
 * OPE-1669 — every Playwright file that declares tests must take `test` from
 * e2e/fixtures.ts, whose `page.goto` / `page.reload` wait for React's streamed
 * Suspense segments to drain. A spec importing straight from "@playwright/test"
 * silently loses that wait and can flake on a hidden duplicate again.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const E2E = join(process.cwd(), "e2e");
const files = readdirSync(E2E, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".ts") && f !== "fixtures.ts");

describe("e2e specs use the stream-settling fixture", () => {
  it("examines the real suite (landmark)", () => {
    expect(files.filter((f) => f.endsWith(".spec.ts")).length).toBeGreaterThan(15);
  });

  it('no file imports `test` from "@playwright/test" directly', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(join(E2E, f), "utf8");
      return /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the fixture wraps both document loads", () => {
    const src = readFileSync(join(E2E, "fixtures.ts"), "utf8");
    expect(src).toContain("page.goto = async");
    expect(src).toContain("page.reload = async");
    expect(src).toContain('div[hidden][id^="S:"]');
  });
});
