/**
 * OPE-1365 — every server-component admin page guards itself.
 *
 * `src/app/admin/layout.tsx`'s role check is NOT an authorization boundary: an
 * `RSC: 1` request whose `Next-Router-State-Tree` names the admin layout as
 * already mounted renders only the page segment, so the layout never runs
 * (reproduced locally — signed out, `/admin/claims` returned the claimant's
 * email). Each `page.tsx` that renders on the server must therefore call
 * `await requireAdmin(...)` as the FIRST statement of its default export, before
 * any data read.
 *
 * Parsed with the TypeScript compiler rather than grepped: a bare
 * `indexOf("requireAdmin")` would be satisfied by the import line alone, and
 * "somewhere in the file" would pass a page that reads D1 before the guard.
 *
 * Client-component pages (`"use client"`) are exempt — they run in the browser
 * and get their data from `/api/admin/**` routes, which carry their own guards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..", "..");
const ADMIN_DIR = join(ROOT, "src", "app", "admin");

function findPages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findPages(p));
    else if (name === "page.tsx" || name === "page.ts") out.push(p);
  }
  return out;
}

function isClientComponent(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  );
}

/** The body of `export default function ...` (or `export default <identifier>` resolved to a local function). */
function defaultExportBody(sf: ts.SourceFile): ts.Block | undefined {
  let exportedName: string | undefined;
  for (const st of sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return st.body;
    }
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
      exportedName = st.expression.text;
    }
  }
  if (!exportedName) return undefined;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === exportedName) return st.body;
  }
  return undefined;
}

/** True when `stmt` is exactly `await requireAdmin(...)`. */
function isRequireAdminCall(stmt: ts.Statement | undefined): boolean {
  if (!stmt || !ts.isExpressionStatement(stmt)) return false;
  const e = stmt.expression;
  return (
    ts.isAwaitExpression(e) &&
    ts.isCallExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === "requireAdmin"
  );
}

function importsRequireAdmin(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === "@/lib/require-admin" &&
      !!st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings) &&
      st.importClause.namedBindings.elements.some((el) => el.name.text === "requireAdmin")
  );
}

function unguardedAdminPages(): { file: string; reason: string }[] {
  const failures: { file: string; reason: string }[] = [];
  for (const file of findPages(ADMIN_DIR)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (isClientComponent(sf)) continue;
    const rel = relative(ROOT, file);
    const body = defaultExportBody(sf);
    if (!body) {
      failures.push({ file: rel, reason: "no default-exported function found" });
    } else if (!importsRequireAdmin(sf)) {
      failures.push({
        file: rel,
        reason: 'does not import requireAdmin from "@/lib/require-admin"',
      });
    } else if (!isRequireAdminCall(body.statements[0])) {
      failures.push({
        file: rel,
        reason: "first statement of the default export is not `await requireAdmin(...)`",
      });
    }
  }
  return failures;
}

describe("OPE-1365 admin page guard", () => {
  it("finds the admin pages (the scan is not vacuous)", () => {
    const pages = findPages(ADMIN_DIR);
    expect(pages.length).toBeGreaterThan(40);
    const serverPages = pages.filter(
      (f) =>
        !isClientComponent(
          ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true)
        )
    );
    // 20 at the time of writing; the floor just proves the filter isn't eating everything.
    expect(serverPages.length).toBeGreaterThanOrEqual(15);
    expect(serverPages.map((f) => relative(ADMIN_DIR, f))).toContain("claims/page.tsx");
  });

  it("every server-component src/app/admin/**/page.tsx starts with `await requireAdmin(...)`", () => {
    expect(unguardedAdminPages()).toEqual([]);
  });

  it("the checker rejects a page that reads data before the guard", () => {
    const sf = ts.createSourceFile(
      "x.tsx",
      `import { requireAdmin } from "@/lib/require-admin";
       export default async function P() { const rows = await load(); await requireAdmin(); return rows; }`,
      ts.ScriptTarget.Latest,
      true
    );
    expect(isRequireAdminCall(defaultExportBody(sf)?.statements[0])).toBe(false);
    expect(importsRequireAdmin(sf)).toBe(true);
  });

  it("the checker rejects an un-awaited guard", () => {
    const sf = ts.createSourceFile(
      "x.tsx",
      `export default async function P() { requireAdmin(); return null; }`,
      ts.ScriptTarget.Latest,
      true
    );
    expect(isRequireAdminCall(defaultExportBody(sf)?.statements[0])).toBe(false);
  });
});
