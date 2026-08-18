/**
 * OPE-433 — every `insert(events)` must NAME `datesConfirmed` and `syncEnabled`.
 *
 * Both are claims the writer is in a position to make and the schema is not:
 *
 *   dates_confirmed — "we have grounds to believe these dates"
 *   sync_enabled    — "a later importer may overwrite this row"
 *
 * They defaulted to `true`, so a row asserted confidence, and granted
 * clobber permission, merely by existing. Two insert paths
 * (promoter/events and promoter/events/draft) were inheriting both silently.
 *
 * Flipping the DDL default is not sufficient protection on its own:
 *
 *   - SQLite keeps the old default on the live table until it is rebuilt, so
 *     the deployed default lags the schema file;
 *   - and the far larger population came from importers that stated `true`
 *     outright (`datesConfirmed: startDate !== null` — presence read as
 *     confirmation), which no default would have prevented.
 *
 * So the durable guarantee is that the writer always says what it means. This
 * check enforces that, and fails CI when a new insert path forgets.
 *
 * Deliberately blunt: it does not judge WHICH value is right, only that a
 * choice was made and is visible at the call site.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "mcp-server/src", "packages"];
const REQUIRED = ["datesConfirmed", "syncEnabled"];

/** Extent of the `.values({ … })` object following an insert(events) call. */
function valuesBlock(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

const failures: string[] = [];
let scanned = 0;

/** Same walk shape as scripts/check-d1-inarray-params.ts. */
function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) yield full;
  }
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file.includes("__tests__") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(file, "utf8");
    let idx = src.indexOf("insert(events)");
    while (idx >= 0) {
      scanned++;
      const block = valuesBlock(src, idx);
      const missing = REQUIRED.filter((k) => !block.includes(`${k}:`));
      if (missing.length > 0) {
        const line = src.slice(0, idx).split("\n").length;
        failures.push(`${file}:${line}  insert(events) does not name: ${missing.join(", ")}`);
      }
      idx = src.indexOf("insert(events)", idx + 1);
    }
  }
}

if (failures.length > 0) {
  console.error("OPE-433 — insert(events) must state its confidence claims:\n");
  for (const f of failures) console.error("  ERROR " + f);
  console.error(
    `\n${failures.length} insert site(s) rely on a DDL default for datesConfirmed/syncEnabled.` +
      `\nBoth are claims the writer makes, not properties of the table. State them explicitly.\n`
  );
  process.exit(1);
}

console.log(`Scanned ${scanned} insert(events) site(s). All name datesConfirmed + syncEnabled.`);
