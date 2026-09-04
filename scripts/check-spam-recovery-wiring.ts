/**
 * OPE-803 — CI guard: the spam-recovery gate stays wired, and stays gated.
 *
 * Two failure modes, both of which look exactly like success:
 *
 *  1. **The detector runs and nothing reads it.** `detectEventTriple` could be
 *     called, its result dropped, and every unit test in
 *     `spam-event-triple-ope803.test.ts` would still pass — they test the
 *     detector, not the routing. That is the shape this repo has shipped
 *     repeatedly (OPE-771, OPE-794, and OPE-477, whose `stagesSkipped` was
 *     produced for two months with no reader).
 *
 *  2. **The gate is bypassed.** If the call site stops consulting
 *     `shouldRecoverSpamRow` and inlines a truthiness check, the literal
 *     string `"false"` becomes enabling and the feature goes live without
 *     anyone deciding to.
 *
 * ⚠️ This guard deliberately does NOT pin the flag's VALUE. Flipping
 * `SPAM_EVENT_RECOVERY_ENABLED` to "true" is John's decision to make, and a
 * check that failed the build when he made it would be a guard defending its
 * author's assumptions rather than the system's invariants. What is pinned is
 * that the flag is DECLARED and CONSULTED — that the switch exists and is the
 * only way through.
 *
 * Run by CI alongside the other check-*.ts guards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const HANDLER = join(ROOT, "mcp-server", "src", "email-handler.ts");
const DETECTOR = join(ROOT, "mcp-server", "src", "email-handlers", "spam-event-triple.ts");
const TOML = join(ROOT, "mcp-server", "wrangler.toml");

function fail(msg: string): never {
  console.error(`Spam-recovery wiring guard FAILED (OPE-803):\n\n${msg}\n`);
  process.exit(1);
}

const handler = readFileSync(HANDLER, "utf8");
const detector = readFileSync(DETECTOR, "utf8");
const toml = readFileSync(TOML, "utf8");

// Positive landmark first. Every check below is a substring test, and all of
// them pass vacuously against a file that was renamed, moved, or emptied.
if (!handler.includes("SPAM_QUARANTINE_THRESHOLD")) {
  fail(
    `  ${HANDLER}\n  does not mention SPAM_QUARANTINE_THRESHOLD. The guard is pointed at the\n` +
      `  wrong file, or the quarantine branch has been restructured. Fix that\n  before trusting anything below.`
  );
}
if (!detector.includes("export function detectEventTriple")) {
  fail(`  ${DETECTOR}\n  does not export detectEventTriple. Wrong file, or the detector is gone.`);
}

// 1. The detector is actually CALLED from the routing path.
if (!handler.includes("detectEventTriple(")) {
  fail(
    `  email-handler.ts never calls detectEventTriple().\n\n` +
      `  The detector exists and its unit tests pass, and it runs on nothing.\n` +
      `  That is the defect class this repo keeps shipping — a control built and\n` +
      `  never invoked is indistinguishable from one that was never built.`
  );
}

// 2. The gate is consulted rather than re-implemented inline.
if (!handler.includes("shouldRecoverSpamRow(")) {
  fail(
    `  email-handler.ts does not call shouldRecoverSpamRow().\n\n` +
      `  The routing decision must go through the tested predicate. An inline\n` +
      `  check is untested by construction (computeRouting is private and calls\n` +
      `  the AI classifier), and a truthiness test on the flag would read the\n` +
      `  literal string "false" as enabled.`
  );
}

// 3. The gate compares to the exact string, not truthiness.
if (!/flagValue === "true"/.test(detector)) {
  fail(
    `  shouldRecoverSpamRow no longer compares the flag to the exact string "true".\n\n` +
      `  SPAM_EVENT_RECOVERY_ENABLED is a plaintext Workers [vars] entry: it\n` +
      `  arrives as a string, never a boolean. Under a truthiness check the\n` +
      `  shipped value "false" enables the feature.`
  );
}

// 4. The flag is declared in the committed toml, so a deploy cannot drop it.
if (!/^SPAM_EVENT_RECOVERY_ENABLED\s*=/m.test(toml)) {
  fail(
    `  SPAM_EVENT_RECOVERY_ENABLED is not declared in mcp-server/wrangler.toml.\n\n` +
      `  A dashboard-only value is wiped by the next \`wrangler deploy\`, which\n` +
      `  replaces the whole [vars] block from the committed file. The flag must\n` +
      `  live here or it does not reliably exist.`
  );
}

const value = toml.match(/^SPAM_EVENT_RECOVERY_ENABLED\s*=\s*"([^"]*)"/m)?.[1] ?? "(unset)";
console.log(
  `Spam-recovery wiring guard passed — detector called, gate consulted, ` +
    `exact-string comparison intact, flag declared (currently "${value}").`
);
