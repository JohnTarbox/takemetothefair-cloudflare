/**
 * OPE-1394 (FLG9) — CAPABILITY_FLAGS must account for every flag-like var the
 * two Workers actually read or declare.
 *
 * The inventory is hand-written on purpose (see dark-capabilities.ts), and that
 * is how it drifted: 8 entries while the code read 15 `*_ENABLED` vars. This
 * test keeps the human sentence but takes the "did anyone write one?" question
 * away from memory.
 *
 * ── The matching rule ───────────────────────────────────────────────────────
 * A name is FLAG-LIKE when EITHER
 *   (a) it matches  /\b[A-Z][A-Z0-9_]*_(ENABLED|DRY_RUN)\b/  in non-comment
 *       source code under src/, mcp-server/src/ or packages/<pkg>/src/
 *       (tests, *.d.ts, and the inventory + its dark-rule file excluded — the
 *       inventory naming a flag must not count as the code reading it), OR
 *   (b) it is a top-level [vars] key in wrangler.toml or mcp-server/wrangler.toml
 *       whose value is exactly "true" or "false" (catches boolean flags that
 *       break the naming convention, e.g. CONDITIONAL_GET_PUBLIC_CACHE,
 *       EMIT_PERFORMER_SUBEVENTS).
 * Non-boolean flags (FAQ_PILOT_EVENT_SLUGS, a slug list) cannot be found by a
 * rule; they are listed by hand and only checked for staleness.
 *
 * Every flag-like name must be in CAPABILITY_FLAGS or NON_CAPABILITY_FLAGS.
 * Conversely every name in either list must still be read in code or declared
 * in a [vars] — so neither list can carry a retired flag.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  findRepoRoot,
  readWranglerConfig,
  wranglerVars,
} from "../../../../scripts/lib/wrangler-config";
import { CAPABILITY_FLAGS, NON_CAPABILITY_FLAGS } from "../dark-capabilities";

const ROOT = findRepoRoot();

const EXCLUDED_FILES = new Set([
  join("src", "lib", "analytics-overview", "dark-capabilities.ts"),
  join("packages", "constants", "src", "capability-flag-dark.ts"),
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.d\.ts$/.test(name) &&
      !/\.(test|spec)\.tsx?$/.test(name) &&
      !EXCLUDED_FILES.has(relative(ROOT, full))
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Drop block and line comments. `//` after `:`/quote is kept (URLs in strings). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function codeCorpus(): string {
  const roots = [join(ROOT, "src"), join(ROOT, "mcp-server", "src")];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const s = join(ROOT, "packages", pkg, "src");
    try {
      if (statSync(s).isDirectory()) roots.push(s);
    } catch {
      /* package without src/ */
    }
  }
  return roots
    .flatMap((r) => sourceFiles(r))
    .map((f) => stripComments(readFileSync(f, "utf8")))
    .join("\n");
}

const FLAG_NAME_RE = /\b[A-Z][A-Z0-9_]*_(?:ENABLED|DRY_RUN)\b/g;

function flagLikeNames(
  code: string,
  varsByWorker: Record<string, Record<string, unknown>>
): Set<string> {
  const names = new Set<string>(code.match(FLAG_NAME_RE) ?? []);
  for (const vars of Object.values(varsByWorker)) {
    for (const [k, v] of Object.entries(vars)) {
      if (v === "true" || v === "false") names.add(k);
    }
  }
  return names;
}

const VARS = {
  "main-app": wranglerVars(readWranglerConfig("main")),
  mcp: wranglerVars(readWranglerConfig("mcp")),
};
const CODE = codeCorpus();

describe("OPE-1394 — capability inventory is complete", () => {
  it("the scan is live (finds known flags from both rules)", () => {
    const found = flagLikeNames(CODE, VARS);
    // (a) a code-read *_ENABLED that is in no [vars]
    expect(found.has("GOODWILL_FLIP_ENABLED")).toBe(true);
    // (b) a boolean [vars] key outside the naming convention
    expect(found.has("CONDITIONAL_GET_PUBLIC_CACHE")).toBe(true);
  });

  it("every flag-like var is in CAPABILITY_FLAGS or NON_CAPABILITY_FLAGS", () => {
    const listed = new Set([
      ...CAPABILITY_FLAGS.map((f) => f.name),
      ...Object.keys(NON_CAPABILITY_FLAGS),
    ]);
    const missing = [...flagLikeNames(CODE, VARS)].filter((n) => !listed.has(n)).sort();
    expect(
      missing,
      `Unlisted flag(s): add each to CAPABILITY_FLAGS (with what is dark while it is off) ` +
        `or to NON_CAPABILITY_FLAGS (with why it withholds nothing from a person).`
    ).toEqual([]);
  });

  it("no inventory entry names a retired flag", () => {
    const declared = new Set([...Object.keys(VARS["main-app"]), ...Object.keys(VARS.mcp)]);
    const stale = [...CAPABILITY_FLAGS.map((f) => f.name), ...Object.keys(NON_CAPABILITY_FLAGS)]
      .filter((n) => !declared.has(n) && !new RegExp(`\\b${n}\\b`).test(CODE))
      .sort();
    expect(stale).toEqual([]);
  });

  it("no name is in both lists, and every exclusion has a reason", () => {
    for (const f of CAPABILITY_FLAGS) expect(NON_CAPABILITY_FLAGS).not.toHaveProperty(f.name);
    for (const reason of Object.values(NON_CAPABILITY_FLAGS))
      expect(reason.length).toBeGreaterThan(20);
  });

  it("a flag declared on exactly one Worker is inventoried under THAT Worker", () => {
    // The capability-flags route resolves main-app flags from its own env and
    // leaves mcp ones to the MCP Worker — a wrong `worker` reports a lit flag
    // as dark (or unknown) every Monday.
    const wrong = CAPABILITY_FLAGS.filter((f) => {
      const inMain = f.name in VARS["main-app"];
      const inMcp = f.name in VARS.mcp;
      if (inMain === inMcp) return false;
      return (inMain ? "main-app" : "mcp") !== f.worker;
    }).map((f) => `${f.name} [${f.worker}]`);
    expect(wrong).toEqual([]);
  });

  it("comment stripping keeps URLs and drops comments", () => {
    expect(stripComments('const u = "https://x"; // FOO_ENABLED')).toBe('const u = "https://x"; ');
    expect(stripComments("/* BAR_ENABLED */ x")).toBe(" x");
  });
});
