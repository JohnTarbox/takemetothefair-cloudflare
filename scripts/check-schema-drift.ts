#!/usr/bin/env tsx
/**
 * Verify that shared tables in `mcp-server/src/schema.ts` match the
 * canonical definitions in `src/lib/db/schema.ts`.
 *
 * Background: the MCP server runs as a separate Cloudflare Worker and
 * connects directly to the same D1 database, so it carries its own
 * Drizzle schema declarations for the tables it touches. Historically
 * "KEEP IN SYNC" was a comment-only contract — this script makes drift
 * detectable in CI.
 *
 * Usage:
 *   npx tsx scripts/check-schema-drift.ts
 *
 * Exits 0 if shared tables match, 1 with a diff hint if they don't.
 *
 * Heuristic: extract each `export const X = sqliteTable("table_name", {`
 * block from both files, normalize whitespace and trailing-comma noise,
 * and string-compare the column body. Tables present in only one file
 * are ignored (the MCP server intentionally has a subset).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MAIN_SCHEMA = resolve(ROOT, "src/lib/db/schema.ts");
const MCP_SCHEMA = resolve(ROOT, "mcp-server/src/schema.ts");

/**
 * Tables that have pre-existing drift between the two files as of the
 * 2026-05-01 audit. Listed here so the script catches drift on tables
 * that are currently aligned without forcing the date-architecture plan
 * to also reconcile every historical schema divergence. Each entry is a
 * known follow-up to clean up in a separate pass.
 */
const KNOWN_DRIFT_ALLOWLIST = new Set<string>(["events", "event_vendors", "content_links"]);

interface TableDef {
  exportName: string;
  tableName: string;
  body: string;
}

function extractTableDefs(source: string): Map<string, TableDef> {
  const out = new Map<string, TableDef>();
  const headerRe = /export\s+const\s+(\w+)\s*=\s*sqliteTable\s*\(\s*"([^"]+)"\s*,\s*\{/g;
  for (const match of source.matchAll(headerRe)) {
    const exportName = match[1];
    const tableName = match[2];
    const startIdx = (match.index ?? 0) + match[0].length;
    // Walk forward to the matching closing brace at the same nesting depth.
    let depth = 1;
    let i = startIdx;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced
    const body = source.slice(startIdx, i - 1);
    out.set(tableName, { exportName, tableName, body });
  }
  return out;
}

/** Normalize whitespace, comments, and trailing-comma noise for comparison. */
function normalize(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* ... */ comments
    .replace(/\/\/.*$/gm, "") // // line comments
    .replace(/,(\s*[)}\]])/g, "$1") // trailing commas before closers
    .replace(/\s+/g, " ")
    .trim();
}

function main() {
  const mainSrc = readFileSync(MAIN_SCHEMA, "utf8");
  const mcpSrc = readFileSync(MCP_SCHEMA, "utf8");

  const mainTables = extractTableDefs(mainSrc);
  const mcpTables = extractTableDefs(mcpSrc);

  const drifts: string[] = [];
  const allowedDrifts: string[] = [];
  for (const [tableName, mcpDef] of mcpTables) {
    const mainDef = mainTables.get(tableName);
    if (!mainDef) {
      drifts.push(
        `Table "${tableName}" exists in mcp-server/src/schema.ts but not in src/lib/db/schema.ts`
      );
      continue;
    }
    if (normalize(mainDef.body) !== normalize(mcpDef.body)) {
      const message =
        `Table "${tableName}" differs:\n` +
        `  main: ${mainDef.exportName} (src/lib/db/schema.ts)\n` +
        `  mcp:  ${mcpDef.exportName} (mcp-server/src/schema.ts)\n` +
        `  Update mcp-server/src/schema.ts to match the canonical definition.`;
      if (KNOWN_DRIFT_ALLOWLIST.has(tableName)) {
        allowedDrifts.push(message);
      } else {
        drifts.push(message);
      }
    }
  }

  if (allowedDrifts.length > 0) {
    console.warn(`Known pre-existing drift on ${allowedDrifts.length} table(s) (allowlisted):`);
    for (const d of allowedDrifts) {
      console.warn("  - " + d.split("\n")[0]);
    }
    console.warn("");
  }

  if (drifts.length === 0) {
    console.log(
      `OK ${mcpTables.size} shared table${mcpTables.size === 1 ? "" : "s"} match between main schema and MCP schema.`
    );
    process.exit(0);
  }

  console.error("MCP schema drift detected:\n");
  for (const d of drifts) {
    console.error(d + "\n");
  }
  console.error("If the divergence is intentional, update this script to allowlist the table(s).");
  process.exit(1);
}

main();
