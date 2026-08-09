/**
 * OPE-348 — `record_agent_heartbeat`.
 *
 * The signal the Cloudflare watchdog watches. Every scheduled agent session
 * calls this once at the start of its run (RUNNER.md step 1), which is what
 * makes "no heartbeat in 26h" mean "sessions are not running".
 *
 * It has to be a call an AGENT makes. During the 2026-08-05→09 quota outage
 * `admin_actions` kept receiving rows — all of them written by Cloudflare crons
 * that were unaffected — so any watchdog keyed on existing tables would have
 * reported healthy for four days straight.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerAgentHeartbeatTools(
  server: McpServer,
  auth: AuthContext,
  env?: MainAppEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "record_agent_heartbeat",
    [
      "OPE-348 — stamp that THIS agent session is alive. Call once at the start of every",
      "scheduled run (RUNNER.md step 1), before doing anything else.",
      "",
      "A Cloudflare cron emails John if no agent heartbeat is newer than 26h. That cron has",
      "no Anthropic dependency, so it survives the exact failure it exists to catch: on",
      "2026-08-05 the account's quota ran out and every scheduled session died silently for",
      "four days, because all our dead-man checks ran on that same account.",
      "",
      "Skipping this call does not fail your run — it makes the watchdog think the agent",
      "layer is down, which pages John. Call it. Admin only.",
    ].join(" "),
    {
      agent_code: z
        .string()
        .min(1)
        .max(64)
        .describe("Your agent code, e.g. 'developer-claude-code'."),
      note: z
        .string()
        .max(500)
        .optional()
        .describe("Optional short context, e.g. the run's queue result."),
    },
    async ({ agent_code, note }) => {
      let response: Response;
      try {
        response = await mainAppFetch(env ?? {}, "/api/internal/agent-heartbeat", "fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentCode: agent_code, note }),
        });
      } catch (err) {
        return {
          content: [jsonContent({ ok: false, error: "transport", message: String(err) })],
          isError: true,
        };
      }
      const payload = await response.json().catch(() => ({ error: "unparseable_response" }));
      return response.ok
        ? { content: [jsonContent(payload)] }
        : { content: [jsonContent({ status: response.status, body: payload })], isError: true };
    }
  );
}
