/**
 * OPE-1511 — `get_contact_scorecard`: one read-only roll-up of how we manage
 * contacts and correspondence. The computation and every query live in
 * packages/db-schema/src/contact-scorecard.ts (shared with the admin tile);
 * this file only exposes them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeContactScorecard, CONTACT_SCORECARD_QUERIES } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerContactScorecardTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_contact_scorecard",
    [
      "OPE-1511 — contact relationship scorecard: coverage, our responsiveness, their",
      "responsiveness, data yield, accuracy (contact vs website citations) and leakage.",
      "",
      "`current` and `prior` are consecutive windows of `window_days` (default 28) for the",
      "flow metrics; `coverage` and `allTime` are point-in-time. Rates are NULL on an empty",
      "denominator, never 0. Our-responsiveness is a FLOOR: replies sent from Gmail never",
      "reach email_send_ledger.",
      "",
      "Every number is one of these queries (:from/:to = window bounds, :now = read time,",
      "unix seconds), so any figure can be reproduced against D1:",
      "",
      ...Object.entries(CONTACT_SCORECARD_QUERIES).map(([name, text]) => `[${name}]\n${text}\n`),
      "Read-only. Admin only.",
    ].join("\n"),
    {
      window_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(28)
        .describe("Length of the current and prior windows, in days."),
    },
    async ({ window_days }) => {
      const card = await computeContactScorecard(db, { windowDays: window_days });
      return { content: [jsonContent(card)] };
    }
  );
}
