/**
 * OPE-1548 — structural guard: every password field in the main app goes
 * through the shared <PasswordInput>, so every one gets the show/hide toggle.
 *
 * A raw `type="password"` anywhere in src/ (outside the component itself)
 * is a field that silently ships without the toggle. NextAuth's provider
 * config in src/lib/auth.ts uses the object form `type: "password"`, which is
 * not markup and is deliberately not matched.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const COMPONENT = join(SRC, "components", "ui", "password-input.tsx");
const RAW_PASSWORD_TYPE = /type\s*=\s*(?:\{\s*)?["'`]password["'`]/;

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      tsxFiles(p, acc);
    } else if (e.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

describe("password fields use the shared PasswordInput (OPE-1548)", () => {
  const files = tsxFiles(SRC);

  it('no raw type="password" outside the shared component', () => {
    const offenders = files
      .filter((f) => f !== COMPONENT)
      .filter((f) => RAW_PASSWORD_TYPE.test(readFileSync(f, "utf8")))
      .map((f) => relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });

  it("positive landmark: the scan saw the app, and the five known fields use PasswordInput", () => {
    // Without this, a scan that found no files would pass the test above.
    expect(files.length).toBeGreaterThan(100);
    const uses = files.reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/<PasswordInput\b/g)?.length ?? 0),
      0
    );
    // login (1) + register (2) + reset-password (2)
    expect(uses).toBeGreaterThanOrEqual(5);
  });
});
