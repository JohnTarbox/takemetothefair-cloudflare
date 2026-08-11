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
import { runAgentSilenceWatchdog, type WatchdogEnv } from "../agent-silence-watchdog.js";

type HeartbeatToolEnv = MainAppEnv & Partial<WatchdogEnv>;

export function registerAgentHeartbeatTools(
  server: McpServer,
  auth: AuthContext,
  env?: HeartbeatToolEnv
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

  /**
   * OPE-348 rework — the fire drill, on the surface an operator can actually reach.
   *
   * The first cut of this shipped as an `X-Internal-Key` endpoint, which is a
   * credential no operator and no agent holds — a drill nobody can fire is not a
   * drill. The admin MCP token IS held, so this is the correct surface, and it
   * calls the watchdog in-process rather than taking an HTTP hop to itself.
   *
   * It injects only a clock and a threshold; the read, verdict, message, enqueue
   * and delivery are the same lines the 08:00Z cron runs.
   */
  server.tool(
    "run_agent_silence_drill",
    [
      "OPE-348 — fire-drill the agent-silence watchdog. Proves the ALARM works, not just the",
      "check: an alarm that has only ever reported 'ok' is an assumption, and this watchdog is",
      "the one that catches the outage which disables every other safeguard.",
      "",
      "Injects only a clock (now_iso) and a threshold (threshold_hours) — everything downstream",
      "is the same code path the daily cron runs, so a real email_send_ledger row is produced.",
      "",
      "SAFETY: send=false (default) is a dry run that reports what it WOULD send and mails",
      "nobody. send=true delivers to the real operator list. Drill mail is subject-prefixed",
      "[DRILL] and never writes the watchdog's own heartbeat row. Admin only.",
    ].join(" "),
    {
      now_iso: z
        .string()
        .optional()
        .describe(
          "Injected clock, ISO-8601. To rehearse silence, pass a time well past the newest heartbeat (e.g. now + 48h)."
        ),
      threshold_hours: z
        .number()
        .optional()
        .describe(
          "Staleness threshold override in hours. Pass a huge value to suppress the silence half and rehearse the newsletter tripwire alone."
        ),
      send: z
        .boolean()
        .optional()
        .describe("Must be true to actually deliver. Defaults to false (dry run)."),
    },
    async ({ now_iso, threshold_hours, send }) => {
      if (!env?.DB) {
        return {
          content: [jsonContent({ ok: false, error: "DB binding unavailable in this context" })],
          isError: true,
        };
      }
      if (now_iso !== undefined && Number.isNaN(Date.parse(now_iso))) {
        return {
          content: [jsonContent({ ok: false, error: "now_iso is not a valid ISO-8601 timestamp" })],
          isError: true,
        };
      }

      const result = await runAgentSilenceWatchdog(
        {
          DB: env.DB,
          EMAIL_JOBS: env.EMAIL_JOBS,
          ALERT_EMAIL_TECHNICAL: env.ALERT_EMAIL_TECHNICAL,
        },
        {
          now: now_iso ? new Date(now_iso) : undefined,
          thresholdMs: threshold_hours !== undefined ? threshold_hours * 60 * 60 * 1000 : undefined,
          drill: true,
          dryRun: send !== true,
        }
      );
      return { content: [jsonContent(result)] };
    }
  );
}
