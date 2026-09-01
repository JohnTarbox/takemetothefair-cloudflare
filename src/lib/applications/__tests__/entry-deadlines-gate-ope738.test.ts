/**
 * OPE-738 — the gate must ship DARK, and it must stay that way until John says
 * otherwise.
 *
 * The ticket STOP-gates a new customer-facing surface on issue-level approval.
 * The code is merged and deployed ahead of that approval deliberately, so the
 * only thing standing between a visitor and an unapproved public page is one
 * string in wrangler.toml. That makes the string worth a test.
 *
 * Keyed on the ACT, not on the fix: this asserts the committed default is OFF
 * and that the route and its footer link both consult the same flag. A guard
 * that only checked "the flag exists" would go green against a page that never
 * reads it — which is the shape of failure this repo keeps logging.
 *
 * When John approves, flipping the value SHOULD fail this test. That is the
 * point: the flip becomes a deliberate, reviewed edit rather than a drive-by.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("OPE-738 — /fair-entry-deadlines ships behind an OFF gate", () => {
  it("declares ENTRY_DEADLINES_INDEX in the committed wrangler.toml", () => {
    // It must live in the committed file, not the dashboard: a dashboard
    // [vars] override is wiped wholesale by the next `wrangler deploy`
    // (OPE-284/OPE-509).
    expect(read("wrangler.toml")).toMatch(/^ENTRY_DEADLINES_INDEX\s*=/m);
  });

  it('has that flag committed as "false"', () => {
    const m = read("wrangler.toml").match(/^ENTRY_DEADLINES_INDEX\s*=\s*"([^"]*)"/m);
    expect(m?.[1]).toBe("false");
  });

  it("404s the route when the flag is off — the page actually consults it", () => {
    const page = read("src", "app", "fair-entry-deadlines", "page.tsx");
    expect(page).toMatch(/isEntryDeadlinesIndexEnabled/);
    // The guard must run before any render, and it must be a notFound().
    expect(page).toMatch(/if\s*\(!isEntryDeadlinesIndexEnabled\(\)\)\s*notFound\(\)/);
  });

  it("gates the footer link on the same flag, so no link points at a 404", () => {
    const footer = read("src", "components", "layout", "footer.tsx");
    expect(footer).toMatch(/isEntryDeadlinesIndexEnabled/);
    expect(footer).toMatch(/fair-entry-deadlines/);
  });

  it("reads the flag through the shared helper, not an ad-hoc env read", () => {
    const flags = read("src", "lib", "flags.ts");
    expect(flags).toMatch(/export function isEntryDeadlinesIndexEnabled/);
    expect(flags).toMatch(/isOn\("ENTRY_DEADLINES_INDEX"\)/);
  });
});
