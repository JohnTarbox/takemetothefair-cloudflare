/**
 * OPE-1292 — the ONE way tests and CI guards read a wrangler.toml.
 *
 * Before this, ten readers each hand-rolled text matching against the two
 * configs: a line regex for a [vars] key, a `[^[]*?` scan for a workflow's
 * class_name, a multi-line regex over `allowed_sender_addresses = [ … ]`, a
 * `queue = ` that had to sit on the very next line after `[[queues.consumers]]`.
 * Each can be fooled by a comment, a moved key, a reformatted array, or a key
 * repeated under another table — and a guard whose regex silently stops
 * matching passes on nothing (OPE-6 v3.8). A parser removes that whole class.
 *
 * Importable from app tests, MCP tests (which run with cwd `mcp-server/`) and
 * `scripts/`. The repo root is found by walking UP from the working directory,
 * not from this file's own URL: `import.meta.url` is not a `file:` URL under the
 * app's CI vitest (see setup-db.ts), and a helper that cannot locate the config
 * would make every guard built on it fail for the wrong reason.
 *
 * Test/CI only — `smol-toml` is a devDependency and nothing here ships to a
 * Worker.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";

export type WranglerWorker = "main" | "mcp";

/** A parsed wrangler.toml. Deliberately loose: callers assert the shape they rely on. */
export type WranglerConfig = Record<string, unknown>;

const CONFIG_PATH: Record<WranglerWorker, string> = {
  main: "wrangler.toml",
  mcp: join("mcp-server", "wrangler.toml"),
};

/** The repo root: the nearest ancestor of `from` holding BOTH configs. */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, CONFIG_PATH.main)) && existsSync(join(dir, CONFIG_PATH.mcp))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `OPE-1292: no repo root above ${from} — expected wrangler.toml and mcp-server/wrangler.toml together`
      );
    }
    dir = parent;
  }
}

export function wranglerConfigPath(worker: WranglerWorker, root: string = findRepoRoot()): string {
  return join(root, CONFIG_PATH[worker]);
}

/** Parse TOML text. Exported so a test can parse a mutated copy without touching the file. */
export function parseWranglerConfig(text: string): WranglerConfig {
  return parse(text) as WranglerConfig;
}

export function readWranglerConfig(
  worker: WranglerWorker,
  root: string = findRepoRoot()
): WranglerConfig {
  return parseWranglerConfig(readFileSync(wranglerConfigPath(worker, root), "utf8"));
}

/** The raw text, for the few checks that are deliberately about COMMENTS (say why at the call). */
export function readWranglerText(worker: WranglerWorker, root: string = findRepoRoot()): string {
  return readFileSync(wranglerConfigPath(worker, root), "utf8");
}

/** Top-level `[vars]` only — never `[env.*.vars]`. Throws if the table is missing. */
export function wranglerVars(config: WranglerConfig): Record<string, unknown> {
  const vars = config.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    throw new Error("OPE-1292: wrangler config has no top-level [vars] table");
  }
  return vars as Record<string, unknown>;
}

/** An array-of-tables (e.g. `queues.consumers`, `workflows`), or [] when absent. */
export function wranglerTables(config: WranglerConfig, path: string): Record<string, unknown>[] {
  let node: unknown = config;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return [];
    node = (node as Record<string, unknown>)[key];
  }
  return Array.isArray(node) ? (node as Record<string, unknown>[]) : [];
}
