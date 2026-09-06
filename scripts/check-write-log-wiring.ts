/**
 * OPE-830 — CI guard: a refused save keeps leaving a record.
 *
 * ## The regression this exists for
 *
 * The vendor-profile PATCH rejects unverified callers at the top of the
 * handler and returns immediately. That early return sits ABOVE every log call
 * in the route, which is why a rejected save left no trace anywhere for the
 * two live "my profile won't save" reports this ticket came from — and why
 * "no record of a save" was indistinguishable from "no save was attempted".
 *
 * The fix is one `recordEntityWrite` call inside that early-return branch.
 * It is also the single easiest thing in this change to lose: anyone
 * refactoring the auth gate deletes a branch, and
 *
 *   - the code compiles,
 *   - every unit test passes (they test the logger, not the route),
 *   - the heartbeat probe stays green (successful saves still write rows),
 *
 * and the instrument silently reverts to recording successes only — which is
 * precisely the blind spot it was built to remove.
 *
 * ⚠️ What would this guard look like if it were INERT? It would pass. So each
 * assertion below is anchored on a specific construct, and each has been
 * driven to failure by deleting the thing it names.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ROUTE = join(ROOT, "src", "app", "api", "vendor", "profile", "route.ts");
const LOGGER = join(ROOT, "src", "lib", "audit", "entity-write-log.ts");
const GATE = join(ROOT, "src", "lib", "api-auth.ts");

function fail(msg: string): never {
  console.error(`Write-log wiring guard FAILED (OPE-830):\n\n${msg}\n`);
  process.exit(1);
}

const route = readFileSync(ROUTE, "utf8");
const logger = readFileSync(LOGGER, "utf8");
const gate = readFileSync(GATE, "utf8");

// ---------------------------------------------------------------------------
// 1. The rejection branch still records.
//
// Scoped to the text BETWEEN the gate check and the `try` that begins the
// success path. A file-wide search would be satisfied by the success-path call
// alone — which is exactly the half that does not need protecting.
// ---------------------------------------------------------------------------
const gateIdx = route.indexOf("const gate = await requireVerifiedSession();");
if (gateIdx === -1) {
  fail(
    `Could not find the verification gate in ${ROUTE}.\n` +
      `If the route was restructured, re-point this guard — do NOT delete it.\n` +
      `Without it, a refused save silently stops being recorded and nothing\n` +
      `else in CI notices.`
  );
}
const tryIdx = route.indexOf("try {", gateIdx);
const rejectionBranch = route.slice(gateIdx, tryIdx === -1 ? route.length : tryIdx);

if (!rejectionBranch.includes("recordEntityWrite")) {
  fail(
    `The vendor-profile PATCH no longer records REFUSED saves.\n\n` +
      `The early return after requireVerifiedSession() must call\n` +
      `recordEntityWrite({ rejectReason: … }) before returning gate.response.\n\n` +
      `Why this matters: that return is above every other log call in the\n` +
      `route, so without it a rejected save leaves NO trace at all — and an\n` +
      `absence of rows then reads as "no save was attempted". That exact\n` +
      `ambiguity is what made OPE-830 unanswerable across two live customer\n` +
      `reports in ten days.\n\n` +
      `File: ${ROUTE}`
  );
}

// ⚠️ Anchored on the property syntax, not the bare word. `includes("rejectReason")`
// was satisfied by `xrejectReason:` — a rename that drops the argument entirely
// while the guard stayed green. Caught by driving this branch to failure.
if (!/(?<![A-Za-z])rejectReason\s*:/.test(rejectionBranch)) {
  fail(
    `The rejection branch calls recordEntityWrite without a rejectReason.\n` +
      `Without it the row is written as an applied/noop write, which is worse\n` +
      `than not writing it: a refusal would be counted as a successful save.`
  );
}

// ---------------------------------------------------------------------------
// 2. The success path diffs, rather than listing payload keys.
// ---------------------------------------------------------------------------
if (!route.includes("diffFields(")) {
  fail(
    `The success path no longer computes a real diff.\n\n` +
      `\`enrichment_log.fields_changed\` is Object.keys(updateData) — the fields\n` +
      `PRESENT in the payload, not the ones that CHANGED. It is byte-identical\n` +
      `across all 18 saves on the OPE-830 specimen and identical on a no-op\n` +
      `resubmit. entity_write_log exists to carry the actual before/after, and\n` +
      `must be fed by diffFields() against the pre-update row.`
  );
}

// The diff is only as wide as its snapshot. A column subset would silently
// report every unselected field as unchanged — the same blind spot one layer
// down, and invisible to every test that does not happen to touch that column.
if (!/const \[currentVendor\] = await db\s*\n?\s*\.select\(\)/.test(route)) {
  fail(
    `The pre-update snapshot is no longer a FULL-row select.\n\n` +
      `\`const [currentVendor] = await db.select()\` must stay unfiltered: a\n` +
      `diff can only report fields it can see, so a column subset reports every\n` +
      `unselected column as unchanged. That is the same class of blind spot as\n` +
      `the fields_changed this replaces, and no test would catch it.\n\n` +
      `File: ${ROUTE}`
  );
}

// ---------------------------------------------------------------------------
// 3. The distinctions the table exists to preserve.
// ---------------------------------------------------------------------------
if (!/changesJson:\s*p\.rejectReason \? null :/.test(logger)) {
  fail(
    `A rejected row's changesJson must be NULL, never [].\n\n` +
      `Nothing was compared. \`[]\` claims we compared and found no differences\n` +
      `— a different and false statement, and the same "two facts, one value"\n` +
      `collapse this table was built to remove.\n\n` +
      `File: ${LOGGER}`
  );
}

// ⚠️ `export type` anchored. Without it `[^;]*` spanned newlines and matched
// the local `const outcome: WriteOutcome = … : "noop";` assignment instead of
// the type, so deleting the union member left this green.
if (!/export type WriteOutcome =[^;]*"noop"/.test(logger) || !/:\s*"noop";/.test(logger)) {
  fail(
    `The \`noop\` outcome is gone.\n\n` +
      `"saved, nothing to do" and "saved, here is what moved" are different\n` +
      `facts. Collapsing them rebuilds the ambiguity of the fields_changed\n` +
      `column this table replaces — which was identical on a resubmit.`
  );
}

// ---------------------------------------------------------------------------
// 4. The gate still hands back who was refused.
// ---------------------------------------------------------------------------
// ⚠️ All three branches, not a file-wide `includes("reason:")` — deleting the
// unauthenticated branch's reason left the guard green because two others
// still matched. A negative assertion needs a positive landmark per branch.
// ⚠️ Search the FUNCTION BODY, not the file. The failure-branch type union
// (`reason: "unauthenticated" | "email_unverified" | ...`) satisfies a naive
// `reason: "<r>"` match for every value, so deleting a real branch left this
// green — the guard was grepping its own type documentation. Third instance of
// that shape in this repo; anchor past the declaration.
const bodyIdx = gate.indexOf("export async function requireVerifiedSession");
if (bodyIdx === -1) {
  fail(`Could not find requireVerifiedSession() in ${GATE} — re-point this guard.`);
}
const gateBody = gate.slice(bodyIdx);
const REASONS = ["unauthenticated", "email_unverified", "verification_check_failed"];
const missingReasons = REASONS.filter((r) => !new RegExp(`reason:\\s*"${r}",`).test(gateBody));
if (missingReasons.length > 0) {
  fail(
    `requireVerifiedSession() failure branches missing a \`reason\`: ` +
      `${missingReasons.join(", ")}.\n\n` +
      `Without it the caller cannot say WHY a save was refused, and the\n` +
      `rejection rows degrade to an undifferentiated "forbidden".\n\n` +
      `File: ${GATE}`
  );
}

console.log(
  "✓ Write-log wiring intact (OPE-830): rejection branch records with a reason, " +
    "success path diffs a full-row snapshot, noop/rejected distinctions preserved"
);
