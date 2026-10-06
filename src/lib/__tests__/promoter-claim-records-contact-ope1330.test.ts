/**
 * OPE-1330 scope item 5 — every write that marks a PROMOTER claimed must record
 * the claimant as a validated promoter contact.
 *
 * Keyed on the ACT, not on the fix: the scan finds every
 * `.update(promoters).set({ … claimed: true … })` in BOTH deploy artifacts and
 * requires a `recordClaimantAsPromoterContact(` call right after it, before the
 * next promoter write. A new claim path that forgets the hook fails here — the
 * "fix wired into 1 of N parallel paths" class this codebase has paid for.
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
const FILES = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "mcp-server", "src"))];
const CLAIM_WRITE = /\.update\(promoters\)\s*\.set\(\{[^}]*\bclaimed:\s*true[^}]*\}\)/g;

const writes: Array<{ file: string; hooked: boolean }> = [];
for (const f of FILES) {
  const src = readFileSync(f, "utf8");
  const matches = [...src.matchAll(CLAIM_WRITE)];
  matches.forEach((m, i) => {
    const end = m.index! + m[0].length;
    const nextWrite = matches[i + 1]?.index ?? src.length;
    const window = src.slice(end, Math.min(nextWrite, end + 900));
    writes.push({
      file: relative(ROOT, f),
      hooked: window.includes("recordClaimantAsPromoterContact("),
    });
  });
}

describe("every promoter claim write records the claimant as a contact", () => {
  it("the scan sees every known claim path (non-vacuous landmark: 7 writes in 6 files)", () => {
    expect(writes.length).toBe(7);
    expect(new Set(writes.map((w) => w.file)).size).toBe(6);
  });

  it("each one is followed by recordClaimantAsPromoterContact", () => {
    const missing = writes.filter((w) => !w.hooked).map((w) => w.file);
    expect(missing, `claim writes with no contact hook: ${missing.join(", ")}`).toEqual([]);
  });
});
