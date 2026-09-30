/**
 * OPE-811 — CI guard: one status vocabulary for `fault_signatures`.
 *
 * The defect this prevents is not a bug in a function. It is two halves of a
 * pipeline drifting apart until they share no words: the code's state machine
 * wrote `proposed`/`filed`/`regressed`/`done` while agents wrote
 * `open`/`noise`/`watch`/`resolved` directly to D1. Measured 2026-09-05, 45 of
 * 68 production rows carried a status the code had never heard of, and 19
 * fileable candidates sat unrouted for up to 15 days while every weekly run
 * reported SUCCEEDED.
 *
 * Neither side was wrong. There was simply no place where both were written
 * down, so nothing could notice they disagreed.
 *
 * What is enforced:
 *
 *  1. `src/lib/faults/status.ts` remains the single declaration.
 *  2. Modules that classify fault statuses import from it rather than
 *     hand-rolling a `new Set([...])` of status strings — the shape that
 *     produced two independent, and differently wrong, "open" definitions in
 *     `fault-health.ts` and `stale-reds.ts`.
 *
 * ⚠️ This does NOT pin the status VALUES. Adding a status is legitimate; adding
 * it in a second place is the defect.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CANON = join(ROOT, "src", "lib", "faults", "status.ts");

function fail(msg: string): never {
  console.error(`Fault-status vocabulary guard FAILED (OPE-811):\n\n${msg}\n`);
  process.exit(1);
}

const canon = readFileSync(CANON, "utf8");

// Positive landmark first — every check below is a substring test and would
// pass vacuously against a moved or gutted file.
if (!canon.includes("export function isFileableStatus")) {
  fail(
    `  ${CANON}\n  does not export isFileableStatus. The canonical vocabulary module is\n` +
      `  missing or was restructured. Fix that before trusting anything below.`
  );
}

// The statuses that actually exist in production. A vocabulary that stops
// naming one of these is a vocabulary that has started lying again.
const REQUIRED = ["proposed", "filed", "regressed", "done", "open", "noise", "watch", "resolved"];

// ⚠️ Parse the two DECLARATION arrays, not the file text.
//
// The first version of this check was `canon.includes(`"${v}"`)`, which passed
// happily when `open` was deleted from AGENT_STATUSES — the word still appeared
// in the FILEABLE set and in three comments. A guard that greps its own
// documentation always agrees with it. Caught by mutating the module and
// finding this check still green.
function declaredIn(constName: string): string[] {
  const m = canon.match(new RegExp(`export const ${constName}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) fail(`  Could not parse ${constName} out of ${CANON}. The guard's parser is stale.`);
  return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}
const declared = new Set([...declaredIn("CODE_STATUSES"), ...declaredIn("AGENT_STATUSES")]);
if (declared.size < 8) {
  fail(
    `  Parsed only ${declared.size} statuses from the declaration arrays; production\n` +
      `  has 8. Either a status was dropped, or the parser has stopped matching —\n` +
      `  fix that rather than trusting the result below.`
  );
}
const missing = REQUIRED.filter((v) => !declared.has(v));
if (missing.length > 0) {
  fail(
    `  These statuses exist in production \`fault_signatures\` but are not named in\n` +
      `  the canonical module:\n` +
      missing.map((m) => `      ${m}`).join("\n") +
      `\n\n  A status the code cannot name is read as "already handled" by the ignore\n` +
      `  bucket, which is exactly how 19 candidates went unrouted for 15 days.`
  );
}

// The classifying modules must defer to the canonical one.
const CONSUMERS = [
  join(ROOT, "src", "lib", "faults", "reconcile.ts"),
  join(ROOT, "src", "lib", "analytics-overview", "fault-health.ts"),
  join(ROOT, "src", "lib", "cpi", "stale-reds.ts"),
];

const offenders: string[] = [];
for (const file of CONSUMERS) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    fail(`  Expected consumer not found: ${file}\n  Update this guard's CONSUMERS list.`);
  }
  if (src.includes('from "./status"') || src.includes('from "@/lib/faults/status"')) continue;
  // Not importing the canon — does it hand-roll a status set instead?
  const handRolled =
    /new Set\(\s*\[\s*"(?:proposed|filed|regressed|open|noise|watch|resolved)"/.test(src);
  if (handRolled) offenders.push(file.replace(ROOT + "/", ""));
}

if (offenders.length > 0) {
  fail(
    `  These modules classify fault statuses from their own hand-rolled list\n` +
      `  instead of importing src/lib/faults/status.ts:\n` +
      offenders.map((o) => `      ${o}`).join("\n") +
      `\n\n  That is the drift itself, not a style preference: fault-health.ts and\n` +
      `  stale-reds.ts each defined "open" as {proposed, filed, regressed}, and\n` +
      `  BOTH omitted the \`open\` status that 8 production rows actually use.\n` +
      `  Import the predicates so there is one answer.`
  );
}

console.log(
  `Fault-status vocabulary guard passed — ${REQUIRED.length} statuses declared in one module, ` +
    `${CONSUMERS.length} consumers defer to it.`
);
