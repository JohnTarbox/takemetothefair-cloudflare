/**
 * OPE-469 — a new MCP tool must be registered on BOTH transports.
 *
 * `mcp-server/src/index.ts` carries two independent registration lists:
 *
 *   OAuth   — inside the `MeetMeAtTheFairMCP` McpAgent class, `register…(this.server, …)`
 *   legacy  — the stateless handler for `mmatf_` Bearer tokens, `register…(server, …)`
 *
 * They are ~40 lines apart and look identical, so registering in one is the
 * natural mistake. It is also invisible: TypeScript is happy, every unit test
 * passes, the deploy goes green, and the tool simply does not exist on the
 * other surface.
 *
 * That is not hypothetical. `replay_inbound_attachment` shipped registered only
 * on the OAuth path and was absent from `tools/list` under an `mmatf_` token —
 * which is precisely the path an agent uses for direct curl when its tool
 * registry is frozen at session start, i.e. the one the ticket needed.
 *
 * Same family as the CLAUDE.md correction shipped alongside it: a fix wired
 * into one of two parallel paths. The difference is that this one is
 * mechanically checkable, so it should be checked rather than remembered.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = join(process.cwd(), "mcp-server", "src", "index.ts");

/**
 * Registrars deliberately absent from the legacy `mmatf_` path.
 *
 * Every entry needs a reason. An unexplained entry here is indistinguishable
 * from the bug this guard exists to catch — which is the whole point of making
 * the omission explicit rather than letting it live in the diff between two
 * lists nobody reads side by side.
 */
const LEGACY_EXEMPT: Record<string, string> = {
  // ⚠️ UNREVIEWED. Found by this guard on first run (OPE-469, 2026-08-18), not
  // deliberately chosen. They may well be the same defect — both were added
  // after the legacy path stopped being routinely updated. Listed rather than
  // silently "fixed" because adding them changes what an `mmatf_` token can
  // reach, which is an operator decision, not a lint fix.
  registerMarketPlayerTools: "UNREVIEWED — OPE-414 tooling; likely an omission, not a choice",
  registerSyndicationTools: "UNREVIEWED — SYN1 tooling; likely an omission, not a choice",
};

function main() {
  const source = readFileSync(INDEX, "utf8");

  // `register…(this.server` → the OAuth list. `register…(server,` → the legacy
  // list. The two call shapes are what distinguishes them; there is no other
  // marker in the file.
  const oauth = new Set([...source.matchAll(/\b(register\w+)\(this\.server/g)].map((m) => m[1]));
  const legacy = new Set([...source.matchAll(/\b(register\w+)\(server,/g)].map((m) => m[1]));

  if (oauth.size === 0 || legacy.size === 0) {
    console.error(
      `MCP registration guard FAILED: found ${oauth.size} OAuth and ${legacy.size} legacy ` +
        `registrations in mcp-server/src/index.ts. One of the call shapes this guard matches ` +
        `has changed — fix the guard, do not delete it.`
    );
    process.exit(1);
  }

  const missingFromLegacy = [...oauth].filter((r) => !legacy.has(r) && !(r in LEGACY_EXEMPT));
  const missingFromOauth = [...legacy].filter((r) => !oauth.has(r));

  const errors: string[] = [];

  if (missingFromLegacy.length > 0) {
    errors.push(
      `Registered on the OAuth path but NOT on the legacy \`mmatf_\` path:\n` +
        missingFromLegacy.map((r) => `      ${r}`).join("\n") +
        `\n  The tool will be missing from tools/list under an mmatf_ Bearer token — the path\n` +
        `  used for direct curl when an agent's tool registry is frozen. Add the same call to\n` +
        `  the stateless handler, or add it to LEGACY_EXEMPT with a reason.`
    );
  }

  if (missingFromOauth.length > 0) {
    errors.push(
      `Registered on the legacy path but NOT on the OAuth path:\n` +
        missingFromOauth.map((r) => `      ${r}`).join("\n") +
        `\n  The tool will be missing for every OAuth client, including Claude.ai.`
    );
  }

  if (errors.length > 0) {
    console.error("MCP tool registration guard FAILED (OPE-469):\n");
    for (const e of errors) console.error(`  - ${e}\n`);
    process.exit(1);
  }

  const exempt = Object.keys(LEGACY_EXEMPT).length;
  console.log(
    `MCP tool registration guard passed — ${oauth.size} registrars on the OAuth path, ` +
      `${legacy.size} on the legacy path, ${exempt} explicitly exempt.`
  );
}

main();
