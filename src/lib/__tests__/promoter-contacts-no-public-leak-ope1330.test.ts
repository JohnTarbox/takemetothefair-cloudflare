/**
 * OPE-1330 — promoter contacts are personal data. No contact name, email or
 * phone may reach a public page, JSON-LD, the sitemap, or a public API/MCP
 * response.
 *
 * Structural guard: the only source files allowed to touch the table (or the
 * component / presenter that render it) are the admin-only ones listed below.
 * A public page, public API route or public MCP tool that starts reading
 * `promoter_contacts` fails here before it can ship. (The behavioural half —
 * the public `get_promoter_details` returns no contact data — lives in
 * mcp-server/__tests__/promoter-contacts-tools-ope1330.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const TOKENS = [
  /\bpromoterContacts\b/,
  /promoter_contacts/,
  /\bPromoterContactsSection\b/,
  /\bpresentPromoterContact\b/,
];

/** Admin-only by construction. Each entry says why. */
const ALLOWED: Array<{ path: RegExp; why: string }> = [
  { path: /^src\/app\/api\/admin\//, why: "admin API (withAuth role ADMIN)" },
  { path: /^src\/app\/admin\//, why: "admin pages" },
  { path: /^src\/components\/admin\/PromoterContactsSection\.tsx$/, why: "admin-only component" },
  {
    path: /^src\/lib\/claims\/promoter-contact\.ts$/,
    why: "writer (claim approval), returns nothing public",
  },
  {
    path: /^mcp-server\/src\/inbound\/promoter-contact-capture\.ts$/,
    why: "writer (inbound capture)",
  },
  { path: /^mcp-server\/src\/promoter-claimant-contact\.ts$/, why: "writer (MCP claim twin)" },
  { path: /^mcp-server\/src\/tools\/admin-promoter-contacts\.ts$/, why: "admin-gated tools" },
  {
    path: /^mcp-server\/src\/tools\/admin-inbound-read\.ts$/,
    why: "admin-gated get_inbound_email",
  },
];

const FILES = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "mcp-server", "src"))];
const touching = FILES.map((f) => ({ abs: f, rel: relative(ROOT, f) })).filter(({ abs }) => {
  const src = readFileSync(abs, "utf8");
  return TOKENS.some((t) => t.test(src));
});

describe("promoter_contacts never reaches a public surface", () => {
  it("only admin-only files touch the table, its presenter or its component", () => {
    const outside = touching
      .map((f) => f.rel)
      .filter((rel) => !ALLOWED.some((a) => a.path.test(rel)));
    expect(outside, `non-admin files touching promoter contacts: ${outside.join(", ")}`).toEqual(
      []
    );
  });

  it("the scan is not vacuous: it finds the known admin readers and writers", () => {
    const rels = touching.map((f) => f.rel);
    for (const must of [
      "mcp-server/src/tools/admin-promoter-contacts.ts",
      "mcp-server/src/inbound/promoter-contact-capture.ts",
      "src/components/admin/PromoterContactsSection.tsx",
      "src/lib/claims/promoter-contact.ts",
    ])
      expect(rels).toContain(must);
  });

  it("every admin API route that touches it is role-gated", () => {
    for (const f of touching.filter((t) => t.rel.startsWith("src/app/api/admin/"))) {
      expect(readFileSync(f.abs, "utf8"), f.rel).toMatch(
        /withAuth<[^>]*>\(\s*\{\s*role:\s*"ADMIN"\s*\}/
      );
    }
  });

  it("every MCP tool file that touches it registers behind the ADMIN gate", () => {
    for (const f of touching.filter((t) => t.rel.startsWith("mcp-server/src/tools/"))) {
      expect(readFileSync(f.abs, "utf8"), f.rel).toContain('if (auth.role !== "ADMIN") return;');
    }
  });

  it("the contacts component is mounted only under /admin", () => {
    const mounts = FILES.map((f) => relative(ROOT, f)).filter((rel) =>
      /<PromoterContactsSection\b/.test(readFileSync(join(ROOT, rel), "utf8"))
    );
    expect(mounts.length).toBeGreaterThan(0);
    expect(mounts.every((m) => m.startsWith("src/app/admin/"))).toBe(true);
  });
});
