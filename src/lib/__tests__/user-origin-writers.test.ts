/**
 * OPE-292 — every placeholder-user writer must stamp `origin`.
 *
 * `users.origin` exists so a real-user count does not have to match an email
 * string. PR #900 added it and stamped `create_vendor` and `create_promoter`;
 * it missed `createOrLinkVendor` in `packages/vendor-linking`, because the
 * audit that accompanied it enumerated `from(users)` sites across `src/` and
 * `mcp-server/src/` and never reached `packages/`.
 *
 * That miss minted **389** mislabelled rows in under two days and took the
 * `registration` partition to 64% placeholders — the column wrong in exactly
 * the way it was introduced to prevent.
 *
 * This is a SOURCE-level check across the whole workspace, deliberately. A
 * behavioural test of any one writer would have passed while the other three
 * were fine and this one was not. What needs asserting is that no
 * `insert(users)` ANYWHERE omits the field.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test source file in the workspace that inserts into `users`. */
function usersInsertSites(): { file: string; snippet: string }[] {
  const hits: { file: string; snippet: string }[] = [];
  for (const dir of ["src", "packages", "mcp-server/src"]) {
    for (const f of walk(join(ROOT, dir))) {
      // Strip comments FIRST. Two files discuss `insert(users)` in prose —
      // including the health-report invariant added for this very defect — and
      // a scanner that counts its own documentation as a call site reports
      // failures nobody can fix.
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      let i = src.indexOf("insert(users)");
      while (i !== -1) {
        // 1200 chars: a values object with field-level comments stripped is
        // still long, and a window that ends before `origin:` reads as a
        // missing stamp.
        hits.push({ file: f.slice(ROOT.length + 1), snippet: src.slice(i, i + 1200) });
        i = src.indexOf("insert(users)", i + 1);
      }
    }
  }
  return hits;
}

describe("users.origin is stamped by every writer", () => {
  const sites = usersInsertSites();

  it("finds the known writers — the scan is not vacuous", () => {
    // Four at the time of writing: the public register route (which
    // legitimately takes the column default) and three placeholder minters.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it("scans packages/, which is where the missed writer lived", () => {
    // The specific blind spot. If this stops matching, the scan has narrowed
    // back to the shape that let 389 rows through.
    expect(sites.some((s) => s.file.startsWith("packages/"))).toBe(true);
  });

  for (const site of sites) {
    it(`${site.file} sets origin, or is the registration path`, () => {
      const setsOrigin = /origin:\s*["']/.test(site.snippet);
      // The public signup route is the ONE writer allowed to rely on the
      // default, and `registration` is that default deliberately: a real signup
      // whose write path forgot the field is merely miscounted, whereas the
      // inverse default would make it vanish from every user surface.
      const isRegistrationRoute = site.file.includes(join("api", "auth", "register"));
      expect(
        setsOrigin || isRegistrationRoute,
        `${site.file} inserts a users row without origin — a placeholder minted here would count as a real registration`
      ).toBe(true);
    });
  }

  it("every placeholder minter stamps 'ingestion' specifically", () => {
    const minters = sites.filter(
      (s) => /pending\+/.test(s.snippet) || s.file.includes("vendor-linking")
    );
    expect(minters.length).toBeGreaterThan(0);
    for (const m of minters) {
      expect(m.snippet, `${m.file} mints a placeholder but does not stamp ingestion`).toMatch(
        /origin:\s*["']ingestion["']/
      );
    }
  });
});
