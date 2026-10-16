#!/usr/bin/env tsx
/**
 * Guard (OPE-1387): a shared projection under src/lib/db/ may never select a
 * WHOLE schema table (`events: events`, `promoter: promoters`, …).
 *
 * Why: `eventJoinProjection` selected `events: events`. Its rows are spread
 * into "use client" components and public JSON, so every events column —
 * `suggester_email`, `submitted_by_user_id`, operator notes, dedup pointers —
 * was serialized into public page source. A shared projection is reused by
 * public pages by design; it must be an explicit column allow-list.
 *
 * Also asserts the two event join projections reference `publicEventColumns`
 * and that the promoter block carries no `userId`.
 *
 * An admin surface that needs a whole row declares its own projection at the
 * (auth-gated) call site — see src/app/api/admin/events/[id]/route.ts.
 *
 * Usage: npx tsx scripts/check-public-event-projection.ts [file ...]
 *   With no args, scans every src/lib/db/**\/*projection*.ts (tests excluded).
 *   Exits 0 if clean, 1 with a list of offenders.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DB_DIR = resolve(ROOT, "src/lib/db");
const PRIMARY = resolve(DB_DIR, "event-join-projection.ts");

function findProjectionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === "__tests__") continue;
      findProjectionFiles(full, out);
    } else if (/projection/i.test(entry) && /\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Identifiers imported from the schema module (the table objects). */
function schemaImports(src: string): string[] {
  const names: string[] = [];
  const re =
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](?:@\/lib\/db\/schema|@takemetothefair\/db-schema)["']/g;
  for (const m of src.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const alias = p
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      names.push(alias);
    }
  }
  return names;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function findViolations(file: string, raw: string): string[] {
  const src = stripComments(raw);
  const out: string[] = [];
  for (const table of schemaImports(src)) {
    // `key: table` followed by `,` `}` or newline — a whole-table select.
    // (`key: table.column` is a column ref and does not match.)
    const re = new RegExp(`(\\w+)\\s*:\\s*${table}\\s*(?=[,}\\n])`, "g");
    for (const m of src.matchAll(re)) {
      out.push(`${relative(ROOT, file)}: whole-table select \`${m[1]}: ${table}\``);
    }
  }
  if (resolve(file) === PRIMARY) {
    for (const name of ["eventJoinProjection", "eventVenueJoinProjection"]) {
      const block = new RegExp(
        `export const ${name}\\s*=\\s*\\{\\s*events:\\s*publicEventColumns\\b`
      );
      if (!block.test(src)) {
        out.push(`${relative(ROOT, file)}: ${name}.events must be \`publicEventColumns\``);
      }
    }
    if (/\buserId\s*:\s*promoters\.userId/.test(src)) {
      out.push(`${relative(ROOT, file)}: promoter.userId must not be in a public projection`);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => resolve(a)) : findProjectionFiles(DB_DIR);
  if (!args.length && !files.some((f) => resolve(f) === PRIMARY)) {
    console.error(
      `check-public-event-projection: ${basename(PRIMARY)} not found — guard is blind.`
    );
    process.exit(1);
  }
  const violations = files.flatMap((f) => findViolations(f, readFileSync(f, "utf8")));
  if (violations.length) {
    console.error("OPE-1387: shared projections must be explicit PUBLIC column allow-lists.\n");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nA whole-table select ships every column (emails, user ids, operator notes) into any" +
        "\npublic page or client component that consumes the projection. List the columns" +
        "\nexplicitly; an admin surface that needs a full row declares its own projection" +
        "\nat its auth-gated call site."
    );
    process.exit(1);
  }
  console.log(`✓ ${files.length} projection file(s) select explicit columns only (OPE-1387).`);
}

main();
