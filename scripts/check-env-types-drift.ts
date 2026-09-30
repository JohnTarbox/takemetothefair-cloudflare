/**
 * OPE-949 — CI fails when a wrangler config gains, loses or retypes a binding
 * without the committed env types being regenerated. Deterministic on every
 * machine.
 *
 * Why not `wrangler types --check`: it compares a config HASH in the generated
 * header, and that hash covers local `.env` / `.dev.vars`. It reports the
 * environment in the vocabulary of drift.
 *
 * Why not a text diff of the interface: wrangler emits a DIFFERENT SHAPE for the
 * same binding depending on whether it can resolve the Worker's entry module —
 *
 *     entry resolvable     BURST_COUNTER: DurableObjectNamespace<import("./src/index").BurstCounter>;
 *                          WORKER_SELF_REFERENCE: Service<typeof import("./.open-next/worker").default>;
 *     entry unresolvable   BURST_COUNTER: DurableObjectNamespace /* BurstCounter *\/;
 *                          WORKER_SELF_REFERENCE: Fetcher /* meetmeatthefair-app *\/;
 *
 * The main app's entry is `.open-next/worker.js`, which exists on a dev box and
 * not in CI's lint job. That is the "identical bytes pass locally, fail in CI"
 * OPE-906 could not explain, and the equal-length-unequal-content extraction:
 * two shapes of the same bindings.
 *
 * So this compares what drift MEANS — the binding NAMES and each one's KIND —
 * after regenerating from a lone copy of the config in a temp dir, where no
 * `.env`, `.dev.vars` or entry module can be read on any machine.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Two spellings of one kind, by entry-module resolvability. */
const KIND_ALIASES: Record<string, string> = { Service: "Fetcher" };

/**
 * Binding name → kind, from the `interface __BaseEnv_<name>` block.
 * The kind is the type's leading identifier: generics, comments and
 * multi-line type arguments are dropped. A string-literal var is `string`.
 */
export function parseEnvBindings(dts: string, interfaceName: string): Map<string, string> {
  const head = `interface __BaseEnv_${interfaceName} {`;
  const start = dts.indexOf(head);
  if (start === -1) throw new Error(`${head} not found`);
  const end = dts.indexOf("\n}", start);
  if (end === -1) throw new Error(`${head} is not closed`);
  const out = new Map<string, string>();
  for (const line of dts.slice(start + head.length, end).split("\n")) {
    // Top-level members only: two-space indent in prettier form, one tab in
    // wrangler's raw form. Deeper lines are a multi-line type argument.
    const m = line.match(
      /^(?: {2}|\t)([A-Za-z_][A-Za-z0-9_]*)\??:\s*("|\{|[A-Za-z_][A-Za-z0-9_]*)/
    );
    if (!m) continue;
    // A JSON var is an inline object type whose members sit one level deeper —
    // which is why only top-level lines are read.
    const kind = m[2] === '"' ? "string" : m[2] === "{" ? "object" : m[2];
    out.set(m[1], KIND_ALIASES[kind] ?? kind);
  }
  return out;
}

export interface DriftReport {
  missing: string[]; // in the config, absent from the committed types
  stale: string[]; // in the committed types, gone from the config
  retyped: Array<{ name: string; committed: string; config: string }>;
}

export function compareBindings(
  committed: Map<string, string>,
  config: Map<string, string>
): DriftReport {
  return {
    missing: [...config.keys()].filter((k) => !committed.has(k)).sort(),
    stale: [...committed.keys()].filter((k) => !config.has(k)).sort(),
    retyped: [...config]
      .filter(([k, v]) => committed.has(k) && committed.get(k) !== v)
      .map(([name, v]) => ({ name, committed: committed.get(name)!, config: v })),
  };
}

export const TARGETS = [
  { config: "wrangler.toml", types: "cloudflare-env.d.ts", iface: "CloudflareEnv" },
  { config: "mcp-server/wrangler.toml", types: "mcp-server/worker-env.d.ts", iface: "WorkerEnv" },
] as const;

/** Types as the config alone implies them: a temp dir holding only the config. */
function regenerate(configPath: string, iface: string): string {
  const dir = mkdtempSync(join(tmpdir(), "env-types-"));
  try {
    copyFileSync(configPath, join(dir, "wrangler.toml"));
    execFileSync(
      join(ROOT, "node_modules/.bin/wrangler"),
      [
        "types",
        "--env-interface",
        iface,
        "--strict-vars",
        "false",
        "--include-runtime",
        "false",
        "out.d.ts",
      ],
      { cwd: dir, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }
    );
    return readFileSync(join(dir, "out.d.ts"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let failed = false;
  for (const t of TARGETS) {
    const committed = parseEnvBindings(readFileSync(join(ROOT, t.types), "utf8"), t.iface);
    const config = parseEnvBindings(regenerate(join(ROOT, t.config), t.iface), t.iface);
    // Landmark: a matcher that extracts nothing makes every comparison equal.
    for (const [label, m] of [
      ["committed", committed],
      ["config", config],
    ] as const) {
      if (m.size < 5 || !m.has("DB")) {
        console.error(
          `✗ ${t.types}: ${label} extraction looks broken (${m.size} bindings, DB ${m.has("DB") ? "present" : "absent"})`
        );
        failed = true;
      }
    }
    const r = compareBindings(committed, config);
    const clean = !r.missing.length && !r.stale.length && !r.retyped.length;
    console.log(
      `${t.types}: ${committed.size} committed / ${config.size} from ${t.config}${clean ? " ✓" : ""}`
    );
    if (!clean) {
      failed = true;
      if (r.missing.length)
        console.error(`✗ in ${t.config} but not ${t.types}: ${r.missing.join(", ")}`);
      if (r.stale.length)
        console.error(`✗ in ${t.types} but no longer in ${t.config}: ${r.stale.join(", ")}`);
      for (const x of r.retyped)
        console.error(`✗ ${x.name}: ${x.committed} in ${t.types}, ${x.config} in ${t.config}`);
    }
  }
  if (failed) {
    console.error(
      "Regenerate with `npm run cf:typegen` from a checkout with NO .env and NO .dev.vars (see src/env-unbound.d.ts), then commit both files."
    );
    process.exit(1);
  }
}
