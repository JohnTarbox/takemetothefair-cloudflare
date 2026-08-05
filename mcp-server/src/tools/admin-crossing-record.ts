/**
 * OPE-326 — `record_crossing`.
 *
 * The Open Engine queue-runner moves an issue from Agent Review back to Agent
 * Working when a reviewer leaves REWORK REQUIRED. That is a membrane crossing
 * in exactly OPE-330's sense — work changing hands — but the runner is a loop
 * of instructions with no Db handle, so `review_to_rework` was a declared
 * crossing type that nothing could write.
 *
 * This is how the runner ledgers it. Without it, OPE-326 would meet its visible
 * behaviour (the issue moves) while silently missing its acceptance criterion
 * (the transition is ledgered) — the "shipped but not executing" shape again.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerCrossingRecordTools(
  server: McpServer,
  auth: AuthContext,
  env?: MainAppEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "record_crossing",
    [
      "OPE-326/OPE-330 — ledger one membrane crossing: a point where WORK changed hands.",
      "",
      "Call this from the queue-runner's step 4b when returning an Agent Review issue to",
      "Agent Working on REWORK REQUIRED feedback: crossing_type='review_to_rework',",
      "source_ref='issue:OPE-nnn', destination_ref='lane:<agent-code>', actor='agent'.",
      "",
      "Why it matters: seven defects this summer shared one shape — work crossed a boundary",
      "and nothing recorded it, so when it stopped moving nobody could say where. A crossing",
      "row makes a MISSING crossing detectable, because each one pairs with a source that",
      "exists. Omit destination_ref for a terminal hold; that NULL is the probe's signal.",
      "",
      "Unlike the in-pipeline ledger helper, this reports failure rather than swallowing it:",
      "a caller told 'recorded' when nothing was written is worse than one told it failed.",
      "Admin only.",
    ].join(" "),
    {
      source_ref: z
        .string()
        .min(1)
        .max(256)
        .describe("Where the work came from — e.g. 'issue:OPE-326', 'inbound_email:<id>'."),
      crossing_type: z
        .enum([
          "email_to_ticket",
          "email_to_hold",
          "hold_to_resolve",
          "review_to_rework",
          "route_to_lane",
        ])
        .describe("Which transition this is."),
      destination_ref: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Where it went — e.g. 'lane:developer-claude-code'. Omit for a terminal hold."),
      actor: z
        .enum(["system", "agent", "human"])
        .optional()
        .describe("Who moved it. Defaults to 'agent'."),
      notes: z.string().max(2000).optional().describe("Short free-text context."),
    },
    async ({ source_ref, crossing_type, destination_ref, actor, notes }) => {
      // Service binding (OPE-258), not the legacy raw-fetch path that 401s.
      let response: Response;
      try {
        response = await mainAppFetch(env ?? {}, "/api/internal/crossings/record", "fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceRef: source_ref,
            crossingType: crossing_type,
            destinationRef: destination_ref,
            actor,
            notes,
          }),
        });
      } catch (err) {
        return {
          content: [jsonContent({ ok: false, error: "transport", message: String(err) })],
          isError: true,
        };
      }

      const payload = await response.json().catch(() => ({ error: "unparseable_response" }));
      // Report failure rather than swallowing it — see the header note.
      return response.ok
        ? { content: [jsonContent(payload)] }
        : { content: [jsonContent({ status: response.status, body: payload })], isError: true };
    }
  );
}
