/**
 * OPE-1397 — every server-component portal page guards itself (the OPE-1365
 * admin-page check, extended to /vendor, /promoter and /dashboard).
 *
 * The portal layouts' role checks are not an authorization boundary: an
 * `RSC: 1` request whose `Next-Router-State-Tree` names the layout as already
 * mounted renders only the page segment. So each server `page.tsx` must call
 * its guard as the FIRST statement of its default export, before any data
 * read:
 *
 *   src/app/vendor/**    → `requireRole("VENDOR", ...)`
 *   src/app/promoter/**  → `requireRole("PROMOTER", ...)`
 *   src/app/dashboard/** → `requireSession(...)`
 *
 * Accepted shapes: `await guard(...)` or `const x = await guard(...)`.
 * Parsed with the TypeScript compiler, not grepped (an `indexOf` would be
 * satisfied by the import line). Client-component pages are exempt — they get
 * their data from API routes, which carry their own guards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..", "..");
const APP = join(ROOT, "src", "app");

interface GuardSpec {
  dir: string;
  fn: "requireRole" | "requireSession";
  /** For requireRole: the required string-literal first argument. */
  roleArg?: "VENDOR" | "PROMOTER";
}

const SPECS: GuardSpec[] = [
  { dir: join(APP, "vendor"), fn: "requireRole", roleArg: "VENDOR" },
  { dir: join(APP, "promoter"), fn: "requireRole", roleArg: "PROMOTER" },
  { dir: join(APP, "dashboard"), fn: "requireSession" },
];

function findPages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findPages(p));
    else if (name === "page.tsx" || name === "page.ts") out.push(p);
  }
  return out;
}

function parse(file: string, text = readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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
    if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {
      exportedName = st.expression.text;
    }
  }
  if (!exportedName) return undefined;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === exportedName) return st.body;
  }
  return undefined;
}

/** The awaited call expression of `await f(...)` or `const x = await f(...)`. */
function awaitedCall(stmt: ts.Statement | undefined): ts.CallExpression | undefined {
  if (!stmt) return undefined;
  let e: ts.Expression | undefined;
  if (ts.isExpressionStatement(stmt)) e = stmt.expression;
  else if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
    e = stmt.declarationList.declarations[0].initializer;
  }
  if (!e || !ts.isAwaitExpression(e) || !ts.isCallExpression(e.expression)) return undefined;
  return e.expression;
}

function isGuardCall(stmt: ts.Statement | undefined, spec: Omit<GuardSpec, "dir">): boolean {
  const call = awaitedCall(stmt);
  if (!call || !ts.isIdentifier(call.expression) || call.expression.text !== spec.fn) return false;
  if (spec.roleArg) {
    const a0 = call.arguments[0];
    return !!a0 && ts.isStringLiteral(a0) && a0.text === spec.roleArg;
  }
  return true;
}

function importsGuard(sf: ts.SourceFile, fn: string): boolean {
  return sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === "@/lib/require-role" &&
      !!st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings) &&
      st.importClause.namedBindings.elements.some((el) => el.name.text === fn)
  );
}

function checkPage(sf: ts.SourceFile, spec: Omit<GuardSpec, "dir">): string | null {
  const body = defaultExportBody(sf);
  if (!body) return "no default-exported function found";
  if (!importsGuard(sf, spec.fn)) return `does not import ${spec.fn} from "@/lib/require-role"`;
  if (!isGuardCall(body.statements[0], spec)) {
    const want = spec.roleArg ? `${spec.fn}("${spec.roleArg}", ...)` : `${spec.fn}(...)`;
    return `first statement of the default export is not \`await ${want}\``;
  }
  return null;
}

function serverPages(dir: string): string[] {
  return findPages(dir).filter((f) => !isClientComponent(parse(f)));
}

function unguardedPortalPages(): { file: string; reason: string }[] {
  const failures: { file: string; reason: string }[] = [];
  for (const spec of SPECS) {
    for (const file of serverPages(spec.dir)) {
      const reason = checkPage(parse(file), spec);
      if (reason) failures.push({ file: relative(ROOT, file), reason });
    }
  }
  return failures;
}

describe("OPE-1397 portal page guard", () => {
  it("finds server pages in every portal dir (the scan is not vacuous)", () => {
    const rel = SPECS.flatMap((s) => serverPages(s.dir).map((f) => relative(APP, f)));
    // 7 at the time of writing (3 dashboard, 1 promoter, 3 vendor).
    expect(rel.length).toBeGreaterThanOrEqual(7);
    expect(rel).toContain("promoter/events/page.tsx");
    expect(rel).toContain("vendor/applications/page.tsx");
    expect(rel).toContain("vendor/calendar/page.tsx");
    expect(rel).toContain("dashboard/claims/page.tsx");
  });

  it("every server-component vendor/promoter/dashboard page starts with its guard", () => {
    expect(unguardedPortalPages()).toEqual([]);
  });

  const vendorSpec = { fn: "requireRole" as const, roleArg: "VENDOR" as const };
  const imp = `import { requireRole, requireSession } from "@/lib/require-role";\n`;

  it("rejects a page that reads data before the guard", () => {
    const sf = parse(
      "x.tsx",
      `${imp}export default async function P() { const s = await auth(); const v = await requireRole("VENDOR"); return s; }`
    );
    expect(checkPage(sf, vendorSpec)).toMatch(/first statement/);
  });

  it("rejects a session-only check where the role guard is required", () => {
    const sf = parse(
      "x.tsx",
      `${imp}export default async function P() { const s = await requireSession("/vendor/x"); return s; }`
    );
    expect(checkPage(sf, vendorSpec)).toMatch(/first statement/);
  });

  it("rejects the wrong role", () => {
    const sf = parse(
      "x.tsx",
      `${imp}export default async function P() { const s = await requireRole("PROMOTER"); return s; }`
    );
    expect(checkPage(sf, vendorSpec)).toMatch(/first statement/);
  });

  it("rejects an un-awaited guard", () => {
    const sf = parse(
      "x.tsx",
      `${imp}export default async function P() { requireRole("VENDOR"); return null; }`
    );
    expect(checkPage(sf, vendorSpec)).toMatch(/first statement/);
  });

  it("rejects a guard that is called but not imported from @/lib/require-role", () => {
    const sf = parse(
      "x.tsx",
      `export default async function P() { const s = await requireRole("VENDOR"); return s; }`
    );
    expect(checkPage(sf, vendorSpec)).toMatch(/does not import/);
  });

  it("accepts both `await guard()` and `const s = await guard()`", () => {
    for (const body of [`await requireRole("VENDOR");`, `const s = await requireRole("VENDOR");`]) {
      const sf = parse("x.tsx", `${imp}export default async function P() { ${body} return null; }`);
      expect(checkPage(sf, vendorSpec)).toBeNull();
    }
  });
});
