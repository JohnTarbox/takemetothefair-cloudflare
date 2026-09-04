/**
 * `get_send_gates` admin MCP tool (OPE-772, 2026-09-04).
 *
 * OPE-648 built the send-gate reader and exposed it at the main app's
 * `/api/admin/capability-flags`. That discharged most of its acceptance and
 * left one hole, which is the whole reason this file exists:
 *
 *   `OPERATOR_OUTBOUND_ENABLED` is enforced on the MCP Worker ONLY.
 *
 * So the main-app reader answers `readable_here: false, enabled: null` for it —
 * correctly, and unhelpfully. The one gate an operator went to the dashboard
 * looking for on 2026-09-02 ("I don't see it on meetmeatthefair-app" — he was
 * right, it is not an app-worker gate) is the one gate no exposed reader could
 * speak for. A gate you cannot read is one you end up testing by sending, which
 * is the prohibited check.
 *
 * This is the same `resolveSendGates` the app route calls — imported from
 * `@takemetothefair/constants`, not re-declared — answering for `"mcp"`.
 * Two copies of "what the send gates are" would defeat the point of a fixed
 * allowlist.
 *
 * SAFETY: takes NO key parameter. There is nothing to pass and therefore
 * nothing to abuse; a generic `get_env(key)` would be a credential-exfiltration
 * tool wearing a diagnostic hat (OPE-648 step 5, restated because it still
 * governs). Adding a gate is a code change that goes through review.
 *
 * READ-ONLY. It cannot change a gate. Values stay operator decisions, made by
 * editing the committed `[vars]` — never the dashboard, which the next
 * `wrangler deploy` silently wipes (OPE-284 / OPE-509).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveSendGates, SEND_GATE_NAMES } from "@takemetothefair/constants";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerSendGatesTool(
  server: McpServer,
  _db: Db,
  auth: AuthContext,
  env?: Record<string, string | undefined>
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_send_gates",
    [
      "Read every outbound send gate as this (MCP) Worker resolves it. READ-ONLY —",
      "it cannot change a gate. Use it to CHECK a gate before sending instead of",
      "discovering its value by sending.",
      "",
      `Fixed allowlist, no key parameter: ${SEND_GATE_NAMES.join(", ")}.`,
      "",
      "A gate this Worker does not enforce reports enabled:null with",
      "readable_here:false — 'not mine to answer for' is NOT the same claim as",
      "'off'. For the main app's own copy, read /api/admin/capability-flags.",
      "OPERATOR_OUTBOUND_ENABLED is enforced HERE and nowhere else, so this tool is",
      "the only place it can be read.",
    ].join(" "),
    {},
    async () => {
      const gates = resolveSendGates(env ?? {}, "mcp");
      return {
        content: [
          jsonContent({
            worker: "mcp",
            gates,
            // An unset gate on the Worker that enforces it is worth calling out
            // rather than leaving the reader to notice a null: `undefined` and
            // "false" behave identically at the send site, but only one of them
            // is also indistinguishable from a broken read.
            unset_but_enforced_here: gates
              .filter((g) => g.readable_here && g.value === null)
              .map((g) => g.name),
            note:
              "Values are set in the committed [vars] of each Worker's wrangler.toml. " +
              "A dashboard edit is wiped by the next deploy (OPE-284/OPE-509).",
          }),
        ],
      };
    }
  );
}
