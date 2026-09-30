/**
 * OPE-975 — the OPE-246 probe rule, machine-enforced.
 *
 * Two checks, one report:
 *
 * 1. INVENTORY. Every execution path the config declares (queue consumers,
 *    Workflows, the jobs `scheduled()` calls) has an entry in
 *    src/lib/heartbeat-inventory.ts naming its probe(s) or a waiver. A new path
 *    with neither fails, and says how to fix it. Every probe an entry names
 *    must exist, and every entry must still correspond to a real path.
 *
 * 2. REGISTRY ↔ SEED. Every HEARTBEAT_PROBES entry has a `heartbeat_probes`
 *    seed row, and every seeded row has a registry entry. The seeded set is
 *    read by APPLYING the migrations to a fresh SQLite and selecting the table —
 *    not by regex over the SQL. Both regex counts in the ticket were wrong (a
 *    `;` inside a note; one-tuple capture), and a later migration can delete or
 *    rename a seed, which only applying them reveals (0277 removed
 *    `newsletter-broadcast`; a grep still finds it in 0168).
 *
 * The report always states what it examined. A matcher that silently matches
 * nothing must not read as a clean bill of health.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRANDFATHERED_UNREVIEWED,
  HEARTBEAT_INVENTORY,
  type InventoryEntry,
} from "../src/lib/heartbeat-inventory";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── discovery ─────────────────────────────────────────────────────────────

/** Registry probe names, parsed from the HEARTBEAT_PROBES array literal. */
export function registryNames(heartbeatSrc: string): string[] {
  const start = heartbeatSrc.indexOf("export const HEARTBEAT_PROBES");
  const end = heartbeatSrc.indexOf("\n];", start);
  if (start === -1 || end === -1) throw new Error("HEARTBEAT_PROBES array not found");
  const block = heartbeatSrc.slice(start, end);
  const names = [...block.matchAll(/\n {4}name: "([^"]+)"/g)].map((m) => m[1]);
  // Landmark: every probe object carries exactly one ownerOpe. If the name
  // matcher and this disagree, the parse is wrong, not the registry.
  const owners = [...block.matchAll(/\n {4}ownerOpe: "/g)].length;
  if (names.length === 0 || names.length !== owners) {
    throw new Error(`registry parse mismatch: ${names.length} names vs ${owners} ownerOpe`);
  }
  return names;
}

/** Seeded probe names after applying every numbered migration in order. */
export function seededNames(drizzleDir: string): {
  names: string[];
  applied: number;
  total: number;
} {
  const files = readdirSync(drizzleDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const db = new Database(":memory:");
  let applied = 0;
  for (const f of files) {
    const sql = readFileSync(join(drizzleDir, f), "utf8");
    try {
      db.exec(sql.replaceAll("--> statement-breakpoint", ""));
      applied++;
    } catch (err) {
      // A handful of 2025 table-rebuild migrations do not replay on an empty
      // SQLite (they assume data shapes). Tolerated ONLY if the file does not
      // touch the probe table — otherwise the answer below would be a guess.
      if (/heartbeat_probes/i.test(sql)) {
        throw new Error(`${f} touches heartbeat_probes and failed to apply: ${String(err)}`);
      }
    }
  }
  const rows = db.prepare("SELECT probe_name FROM heartbeat_probes").all() as Array<{
    probe_name: string;
  }>;
  return { names: rows.map((r) => r.probe_name), applied, total: files.length };
}

/** Execution paths declared by the MCP Worker's config and dispatcher. */
export function discoverPaths(mcpWrangler: string, mcpIndex: string): string[] {
  const paths = new Set<string>();
  for (const m of mcpWrangler.matchAll(/\[\[queues\.consumers\]\]\s*\nqueue = "([^"]+)"/g)) {
    paths.add(`queue:${m[1]}`);
  }
  for (const m of mcpWrangler.matchAll(/\[\[workflows\]\][^[]*?class_name = "([^"]+)"/g)) {
    paths.add(`workflow:${m[1]}`);
  }
  const start = mcpIndex.indexOf("async scheduled(");
  if (start === -1) throw new Error("scheduled() handler not found in mcp-server/src/index.ts");
  const end = mcpIndex.indexOf("\n  },", start);
  const body = mcpIndex
    .slice(start, end)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  for (const m of body.matchAll(/\b(run[A-Z][A-Za-z0-9]*)\(/g)) {
    if (m[1] !== "runMainAppSweep") paths.add(`cron:${m[1]}`);
  }
  for (const m of body.matchAll(/runMainAppSweep\([\s\S]*?"(\/api\/[^"]+)"/g)) {
    paths.add(`cron:main-app:${m[1]}`);
  }
  return [...paths].sort();
}

// ── checks ────────────────────────────────────────────────────────────────

export interface IntegrityInput {
  registry: string[];
  seeded: string[];
  paths: string[];
  inventory: Record<string, InventoryEntry>;
  grandfathered: ReadonlySet<string>;
}

export interface IntegrityReport {
  errors: string[];
  summary: string;
}

export function checkIntegrity(input: IntegrityInput): IntegrityReport {
  const errors: string[] = [];
  const registry = new Set(input.registry);
  const seeded = new Set(input.seeded);

  for (const name of input.registry) {
    if (!seeded.has(name)) {
      errors.push(
        `probe "${name}" is in HEARTBEAT_PROBES but has no heartbeat_probes seed row — add a migration: INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at) VALUES ('${name}', <unixepoch() or NULL if gated>, '<owner OPE — what it watches>', unixepoch()) ON CONFLICT(probe_name) DO NOTHING;`
      );
    }
  }
  for (const name of input.seeded) {
    if (!registry.has(name)) {
      errors.push(
        `seed row "${name}" has no HEARTBEAT_PROBES entry, so nothing reads it (arming it does nothing) — register it in src/lib/heartbeat.ts, or delete the row in a migration that says why (a rename must remove the old name).`
      );
    }
  }

  let probed = 0;
  let waived = 0;
  let unreviewed = 0;
  const pathSet = new Set(input.paths);
  for (const path of input.paths) {
    const entry = input.inventory[path];
    if (!entry) {
      errors.push(
        `execution path "${path}" is not in src/lib/heartbeat-inventory.ts — OPE-246: add { probes: [...] } naming its HEARTBEAT_PROBES entry (ship the probe in this PR), or { waiver: { reason, decided, ope } } if it genuinely should not have one.`
      );
      continue;
    }
    if ("probes" in entry) {
      probed++;
      if (entry.probes.length === 0) errors.push(`"${path}" lists an empty probes array`);
      for (const p of entry.probes) {
        if (!registry.has(p))
          errors.push(`"${path}" names probe "${p}", which is not in HEARTBEAT_PROBES`);
      }
    } else if ("waiver" in entry) {
      waived++;
      if (!entry.waiver.reason.trim() || !entry.waiver.ope.trim()) {
        errors.push(`"${path}" has a waiver with no reason or owner OPE`);
      }
    } else {
      unreviewed++;
      if (!input.grandfathered.has(path)) {
        errors.push(
          `"${path}" is marked unreviewed but was not a path on 2026-09-13 — a new path must name a probe or a waiver, not defer the decision.`
        );
      }
    }
  }
  for (const path of Object.keys(input.inventory)) {
    if (!pathSet.has(path)) {
      errors.push(
        `inventory entry "${path}" matches no current execution path — remove it (or fix the rename).`
      );
    }
  }

  return {
    errors,
    summary:
      `heartbeat probes: ${input.registry.length} registered, ${input.seeded.length} seeded. ` +
      `execution paths: ${input.paths.length} examined, ${probed} probed, ${waived} waived, ` +
      `${unreviewed} unreviewed (grandfathered).`,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

export function runCheck(root = ROOT): IntegrityReport & { applied: number; total: number } {
  const registry = registryNames(readFileSync(join(root, "src/lib/heartbeat.ts"), "utf8"));
  const seeded = seededNames(join(root, "drizzle"));
  const paths = discoverPaths(
    readFileSync(join(root, "mcp-server/wrangler.toml"), "utf8"),
    readFileSync(join(root, "mcp-server/src/index.ts"), "utf8")
  );
  const report = checkIntegrity({
    registry,
    seeded: seeded.names,
    paths,
    inventory: HEARTBEAT_INVENTORY,
    grandfathered: GRANDFATHERED_UNREVIEWED,
  });
  return { ...report, applied: seeded.applied, total: seeded.total };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = runCheck();
  console.log(`${r.summary} (migrations replayed: ${r.applied}/${r.total})`);
  if (r.errors.length > 0) {
    for (const e of r.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log("✓ every path is probed or waived, and the registry matches its seeds");
}
