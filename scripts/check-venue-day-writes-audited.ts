/**
 * OPE-433 scope 5 — every `venues` / `event_days` write must be answerable.
 *
 * The ticket's specimen is what an unaudited write costs: venue `5e6f81ed` was
 * mutated in production at 04:00:20Z on 2026-08-17 — city normalised, address
 * filled, lat/long set — and an agent, a `venues_geocode` sweep and the
 * mafa.org importer were **indistinguishable from the evidence**, because there
 * was none. `get_admin_action_log` reported zero actions in 24 hours.
 *
 * There are ~29 write sites across the two codebases. Wiring them by hand and
 * trusting the next one to remember is how "the fix was wired into one of two
 * parallel paths" keeps happening here. So this is the guard, and the sibling
 * `check-events-insert-confidence.ts` is the argument for it: that one caught a
 * third insert site its author had missed, on its first run.
 *
 * ── What it demands ──────────────────────────────────────────────────────
 *
 * Near every `.insert(venues)` / `.update(venues)` / `.delete(venues)` — and
 * the same three for `eventDays` — there must be evidence the write is
 * recorded: a `buildMutationAudit` call, an `adminActions` insert, or an
 * explicit `AUDIT-EXEMPT:` comment giving a reason.
 *
 * Deliberately blunt. It proves a decision was MADE and is visible at the call
 * site; it cannot prove the decision was right. That is the same bargain the
 * events guard strikes, and it is the one that scales to a reviewer skimming a
 * diff.
 *
 * ── Why an exemption comment rather than a hard ban ──────────────────────
 *
 * Some writes genuinely should not log: a merge that already writes its own
 * `event.merge` / `venue.merge` row would double-count, and a test fixture is
 * not a production mutation. Forcing those through the helper would make the
 * log LESS readable, so the escape hatch is allowed — but it must be typed out,
 * so it appears in review rather than being the silent default.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "mcp-server/src", "packages"];

/** Tables whose public-facing rows must have answerable writes. */
const GUARDED = ["venues", "eventDays"];

/** Any of these near the write counts as "this write is accounted for". */
const EVIDENCE = ["buildMutationAudit", "adminActions", "recordMutation", "AUDIT-EXEMPT:"];

/**
 * How far to look for the evidence, in characters either side.
 *
 * Generous on purpose: the audit usually follows the write, but a batch that
 * collects rows first and logs once afterwards is legitimate and would fail a
 * tight window. A false failure here trains people to add the exemption
 * comment reflexively, which would defeat the guard.
 */
const WINDOW = 1600;

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

const failures: string[] = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file.includes("__tests__") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(file, "utf8");
    for (const table of GUARDED) {
      for (const verb of ["insert", "update", "delete"]) {
        const needle = `${verb}(${table})`;
        let idx = src.indexOf(needle);
        while (idx >= 0) {
          scanned++;
          const near = src.slice(Math.max(0, idx - WINDOW), idx + WINDOW);
          if (!EVIDENCE.some((e) => near.includes(e))) {
            const line = src.slice(0, idx).split("\n").length;
            failures.push(`${file}:${line}  ${needle} has no audit and no AUDIT-EXEMPT reason`);
          }
          idx = src.indexOf(needle, idx + 1);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("OPE-433 — venue / event_day writes must be answerable:\n");
  for (const f of failures) console.error("  ERROR " + f);
  console.error(
    `\n${failures.length} write site(s) mutate a public-facing row with nothing recording who.` +
      `\nThat is the Martha's Vineyard specimen: a production venue changed at 04:00:20Z` +
      `\nand the candidate causes were indistinguishable from the evidence.` +
      `\n\nEither record it (buildMutationAudit → adminActions), or write` +
      `\n  // AUDIT-EXEMPT: <reason>` +
      `\nat the call site so the decision is visible in review.\n`
  );
  process.exit(1);
}

console.log(`Scanned ${scanned} venue/event_day write site(s). All accounted for.`);
