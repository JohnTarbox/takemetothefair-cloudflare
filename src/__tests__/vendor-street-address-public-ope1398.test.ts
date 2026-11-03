/**
 * OPE-1398 — guard: no PUBLIC surface emits a self-signup vendor's street
 * address.
 *
 * The rule (isStreetAddressHidden in @takemetothefair/utils) is unit-tested in
 * packages/utils. This file pins the WIRING, keyed on the act rather than on
 * the fix: any public file that reads a vendor's address — a full vendor row
 * (`.select().from(vendors)`, a `.select()` join onto `vendors`) or the
 * `address` column itself — must pass it through the shared helper with a
 * real call (import lines are stripped first, so an unused import is not
 * enough). A new public surface that forgets the helper goes red here.
 *
 * Admin surfaces and the vendor's own portal (which read the caller's own
 * row) are out of scope by design: admin views keep the full address.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..");

/** Private / own-row trees: admin keeps the full address; the vendor portal reads its own row. */
const EXCLUDED_DIRS = [
  ["src", "app", "admin"],
  ["src", "app", "api", "admin"],
  ["src", "app", "vendor"],
  ["src", "app", "api", "vendor"],
].map((p) => join(ROOT, ...p) + sep);

/** Public-tree files that read a vendor row for a reason that never renders it publicly. */
const ALLOWLIST: Record<string, string> = {
  // getUserVendorInfo: the SIGNED-IN viewer's own vendor row (where userId = session).
  "src/app/events/[slug]/page.tsx": "viewer's own vendor row only",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) {
      if (EXCLUDED_DIRS.some((d) => (p + sep).startsWith(d))) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const READS_VENDOR_ADDRESS = [
  /\.select\(\)\s*\.from\(\s*vendors\s*\)/, // full vendor row
  /\.select\(\)\s*\.from\(\s*\w+\s*\)\s*\.(?:left|inner)Join\(\s*vendors\b/, // full row via join
  /\bvendors\.address\b/, // the column
];

function stripImports(src: string): string {
  return src.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
}

const CALLS_HELPER = /\b(?:withPublicStreetAddress|publicStreetAddress)\s*\(/;

describe("OPE-1398 public vendor surfaces never emit a hidden street address", () => {
  const files = [...walk(join(ROOT, "src", "app")), ...walk(join(ROOT, "src", "components"))];

  it("scans a non-trivial number of public files (the walk is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  const readers = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return READS_VENDOR_ADDRESS.some((re) => re.test(src));
  });

  it("finds the known readers (detail page, event detail loader, favorites, export)", () => {
    const rel = readers.map((f) => relative(ROOT, f).split(sep).join("/"));
    for (const known of [
      "src/app/vendors/[slug]/page.tsx",
      "src/app/events/[slug]/event-detail-data.ts",
      "src/app/dashboard/favorites/page.tsx",
      "src/app/api/vendors/export/route.ts",
    ]) {
      expect(rel).toContain(known);
    }
  });

  it("every public reader of a vendor's address calls the shared helper", () => {
    const offenders = readers
      .map((f) => relative(ROOT, f).split(sep).join("/"))
      .filter((rel) => !(rel in ALLOWLIST))
      .filter((rel) => !CALLS_HELPER.test(stripImports(readFileSync(join(ROOT, rel), "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("the vendor detail page nulls the address at its loader, before JSON-LD and render", () => {
    const src = readFileSync(join(ROOT, "src/app/vendors/[slug]/page.tsx"), "utf8");
    expect(src).toMatch(/\.\.\.withPublicStreetAddress\(vendor\.vendors\)/);
    // The raw row must not be spread anywhere else into the returned object.
    expect(src).not.toMatch(/\.\.\.vendor\.vendors\b/);
  });

  it("the event detail loader hands client components the filtered vendor row", () => {
    const src = readFileSync(join(ROOT, "src/app/events/[slug]/event-detail-data.ts"), "utf8");
    expect(src).toMatch(/vendor:\s*withPublicStreetAddress\(vendor\)/);
  });

  it("MCP public tools never select a vendor's street address or full row", () => {
    const src = readFileSync(join(ROOT, "mcp-server/src/tools/public.ts"), "utf8");
    expect(src).not.toMatch(/\bvendors\.address\b/);
    expect(src).not.toMatch(/\.select\(\)\s*\.from\(\s*vendors\s*\)/);
    expect(src).not.toMatch(
      /\.select\(\)\s*\.from\(\s*\w+\s*\)\s*\.(?:left|inner)Join\(\s*vendors\b/
    );
  });

  it("the registration route marks the vendor it mints as self-signup", () => {
    const src = readFileSync(join(ROOT, "src/app/api/auth/register/route.ts"), "utf8");
    const block = src.match(/insert\(vendors\)\.values\(\{([\s\S]*?)\}\)/);
    expect(block, "register route vendor insert not found").not.toBeNull();
    expect(block![1]).toMatch(/selfSignup:\s*true/);
  });
});
