/**
 * OPE-1374 — an `admin_actions` insert may be best-effort, but its failure may
 * not be SILENT.
 *
 * The audit found `admin_actions` inserts wrapped in `catch { // comment }` in
 * the merge, alias and vendor-hierarchy tools (and 20 more sites): the change
 * committed, the audit row vanished, nothing recorded that it had. Keyed on the
 * ACT (an insert into adminActions) rather than on the fix, so a NEW audit
 * insert with a comment-only catch fails here whether or not it uses
 * `logAuditWriteFailure`.
 *
 * Scans both trees (MCP Worker + main app) from here because the defect class
 * is the same and one guard is easier to keep honest than two.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ROOTS = [path.join(REPO, "mcp-server/src"), path.join(REPO, "src")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const INSERT_RE = /insert\((?:schema\.)?adminActions\)/;
const indentOf = (l: string) => l.length - l.trimStart().length;
const isCommentOrBlank = (l: string) => {
  const t = l.trim();
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
};

interface Finding {
  file: string;
  insertLine: number;
  catchLine: number;
}

/** For every adminActions insert inside a try, return the try's catch if it does nothing. */
export function findSilentAuditCatches(file: string, src: string): Finding[] {
  const L = src.split("\n");
  const out: Finding[] = [];
  L.forEach((line, i) => {
    if (!INSERT_RE.test(line)) return;
    const ind = indentOf(line);
    // Nearest enclosing `try {` (strictly shallower indent).
    let t = i - 1;
    for (; t >= 0; t--) {
      if (/^\s*try \{\s*$/.test(L[t]) && indentOf(L[t]) < ind) break;
      // Leaving the enclosing function body: stop.
      if (/^\S/.test(L[t]) && L[t].trim() !== "") {
        t = -1;
        break;
      }
    }
    if (t < 0) return;
    const tInd = indentOf(L[t]);
    // Its catch: the next line at the try's indent that opens a catch.
    let c = t + 1;
    for (; c < L.length; c++) {
      if (indentOf(L[c]) === tInd && /^\s*\}/.test(L[c])) break;
    }
    // The try must still be open at the insert (an earlier, closed try at a
    // shallower indent is not the one guarding it).
    if (c <= i) return;
    if (c >= L.length || !/\} catch(?: \(\w+\))? \{\s*$/.test(L[c])) return;
    const body: string[] = [];
    for (let b = c + 1; b < L.length; b++) {
      if (indentOf(L[b]) === tInd && /^\s*\}/.test(L[b])) break;
      body.push(L[b]);
    }
    if (body.every(isCommentOrBlank)) {
      out.push({ file: path.relative(REPO, file), insertLine: i + 1, catchLine: c + 1 });
    }
  });
  return out;
}

describe("admin_actions audit catches are never silent (OPE-1374)", () => {
  const files = ROOTS.flatMap((r) => walk(r));
  const withInserts = files.filter((f) => INSERT_RE.test(readFileSync(f, "utf8")));

  it("finds the audit inserts at all (guards against a vacuous pass)", () => {
    expect(withInserts.length).toBeGreaterThan(50);
  });

  it("the detector flags a comment-only catch and passes a logging one", () => {
    const silent = [
      "async function f() {",
      "  try {",
      "    await db.insert(adminActions).values({ action: 'x' });",
      "  } catch {",
      "    // Audit failure must not fail the merge.",
      "  }",
      "}",
    ].join("\n");
    const loud = silent.replace(
      "  } catch {\n    // Audit failure must not fail the merge.",
      "  } catch (error) {\n    // Audit failure must not fail the merge.\n    await logAuditWriteFailure(db, { error });"
    );
    expect(findSilentAuditCatches("x.ts", silent)).toHaveLength(1);
    expect(findSilentAuditCatches("x.ts", loud)).toHaveLength(0);
  });

  it("no adminActions insert sits in a comment-only catch", () => {
    const findings = withInserts.flatMap((f) => findSilentAuditCatches(f, readFileSync(f, "utf8")));
    expect(findings).toEqual([]);
  });
});
