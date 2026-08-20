/**
 * OPE-237 — `corroborate_vendor_claims`: run the declared-website corroboration
 * pass over the vendor realness-screen queue.
 *
 * The classifier and the re-score helper both shipped with PR #791 and had ZERO
 * callers outside their own module; `corroboration_detail` was NULL on all 35
 * evidence rows. This is the trigger the app-side docblock already described as
 * "a separate, admin-triggered pass" — it simply never existed.
 *
 * Thin by design: the app owns the classification, the scoring rules and the
 * write, and this hands over. Reimplementing the rules here would put the same
 * judgement in two deploys, which is how the MCP and app dedup paths drifted
 * before (see the K2 rewire note in CLAUDE.md).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import type { AuthContext } from "../auth.js";

export function registerClaimCorroborateTool(
  server: McpServer,
  auth: AuthContext,
  env: MainAppEnv
): void {
  server.tool(
    "corroborate_vendor_claims",
    "OPE-237 — fetch each vendor's DECLARED website and classify how well it corroborates their claim (STRONG / WEAK / NONE), then re-score the realness band. Only touches rows that have a declared website and have not been corroborated yet, so re-running is cheap and does not re-crawl. Reports why zero when zero. Does NOT write anything to the public vendor profile.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max rows to process (default 10). Each row costs one outbound fetch."),
      vendor_id: z
        .string()
        .optional()
        .describe(
          "Corroborate one specific vendor, ignoring the already-corroborated filter. Use to re-check a row after the vendor edits their website."
        ),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Admin role required." }],
          isError: true,
        };
      }
      const res = await mainAppFetch(env, "/api/admin/claims/corroborate", "fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: params.limit, vendor_id: params.vendor_id }),
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: [
            { type: "text" as const, text: `Corroboration pass failed (${res.status}): ${text}` },
          ],
          isError: true,
        };
      }
      return { content: [jsonContent(JSON.parse(text))] };
    }
  );
}
