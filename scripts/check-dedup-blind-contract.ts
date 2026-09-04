/**
 * OPE-804 — CI guard: the blind-dedup flag must survive the seam between the
 * two deploy artifacts.
 *
 * This is the one way the fix can ship and be inert. Everything else is
 * structurally closed:
 *
 *   - `submitEvent` REQUIRES its dedup context, so a new creation path cannot
 *     compile without stating which verdict permitted it.
 *   - The recorder and the predicate are both mutation-tested.
 *
 * But the flag crosses an HTTP boundary between the main app (which computes
 * it) and the MCP Worker (which acts on it), and those are separate deploys
 * with no shared type. If the route stops emitting `dedupWasBlind`, the MCP
 * side reads `undefined`, `=== true` is false, and every blind creation goes
 * back to looking clean — silently, with no test red anywhere, because each
 * side is individually correct.
 *
 * That is exactly the failure the ticket is about, one level up: an absent
 * signal and a negative signal being the same value.
 *
 * ⚠️ A heartbeat probe cannot cover this. Blind verdicts are sporadic and
 * SHOULD trend toward zero, so a probe on `dedup.blind` row volume would fire
 * on the good outcome — the same false-fire OPE-541's probe had to be
 * corrected for. This checks the contract instead of the yield.
 *
 * Run by `npm run lint`, alongside the other check-*.ts guards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ROUTE = join(ROOT, "src", "app", "api", "suggest-event", "check-duplicate", "route.ts");
const RELAY = join(ROOT, "mcp-server", "src", "email-handlers", "submit.ts");
const CREATE = join(ROOT, "mcp-server", "src", "email-handlers", "submit.ts");

function fail(msg: string): never {
  console.error(`Blind-dedup contract guard FAILED (OPE-804):\n\n${msg}\n`);
  process.exit(1);
}

const route = readFileSync(ROUTE, "utf8");
const relay = readFileSync(RELAY, "utf8");
const create = readFileSync(CREATE, "utf8");

// ── Positive landmark FIRST ──────────────────────────────────────────────
// Every assertion below is a "this substring is present" check, and all of
// them pass vacuously against a file that was moved, renamed, or emptied.
// Anchor on something unrelated to the feature so a mis-pointed path fails
// loudly here rather than reporting a clean bill of health for a file this
// guard never read.
if (!route.includes("findDuplicate")) {
  fail(
    `  ${ROUTE}\n  does not mention findDuplicate. The guard is pointed at the wrong file,\n` +
      `  or the route was restructured. Fix the path before trusting anything below.`
  );
}
if (!create.includes("export async function submitEvent")) {
  fail(`  ${CREATE}\n  does not define submitEvent. The guard is pointed at the wrong file.`);
}

// ── 1. The route must EMIT the flag on every response shape ──────────────
// Two returns: the not-duplicate early return and the duplicate-found body.
// Emitting on only one is the shape this ticket is about — a caller cannot
// tell a missing field from a false one.
const emitted = (route.match(/dedupWasBlind:\s*dedupWasBlind\(/g) ?? []).length;
if (emitted < 2) {
  fail(
    `  The check-duplicate route emits \`dedupWasBlind\` on ${emitted} response shape(s);\n` +
      `  it has two (not-duplicate, and duplicate-found) and both must carry it.\n\n` +
      `  A shape that omits the field hands the MCP side \`undefined\`, which reads\n` +
      `  as "the dedup ran and found nothing" — the exact conflation OPE-804 exists\n` +
      `  to remove.`
  );
}

// ── 2. The MCP relay must READ it off the wire ───────────────────────────
if (!relay.includes("dedupWasBlind")) {
  fail(
    `  mcp-server/src/email-handlers/submit.ts never mentions \`dedupWasBlind\`.\n` +
      `  The route computes the flag and nothing consumes it — OPE-477's outcome,\n` +
      `  repeated: the information exists and changes nothing.`
  );
}
if (!/dedupWasBlind\?:\s*boolean/.test(relay)) {
  fail(
    `  The wire type in submit.ts no longer declares \`dedupWasBlind?: boolean\`.\n` +
      `  Without it the field is dropped at the parse boundary regardless of what\n` +
      `  the route sends.`
  );
}

// ── 3. Creation must ACT on it ───────────────────────────────────────────
if (!create.includes("context.dedupWasBlind")) {
  fail(
    `  submitEvent no longer reads \`context.dedupWasBlind\`.\n` +
      `  The flag would be carried the whole way across the seam and then dropped\n` +
      `  at the one place it was supposed to change something.`
  );
}
if (!/dedupWasBlind:\s*boolean/.test(create)) {
  fail(
    `  \`SubmitEventContext.dedupWasBlind\` is no longer REQUIRED (found optional or\n` +
      `  absent). Making it optional is the quiet way to disable this: every call\n` +
      `  site keeps compiling and new ones stop supplying the verdict.`
  );
}

console.log(
  `Blind-dedup contract guard passed — route emits on ${emitted} shapes, ` +
    `relay parses it, submitEvent requires and acts on it.`
);
