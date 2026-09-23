/**
 * OPE-463 (review bounce 2026-09-23) — the CPI rail's read of `extraction_faults`.
 *
 * The emitter writes `status='proposed'` (the honest name for an unadjudicated
 * candidate), and the acceptance query the ticket wrote reads
 * `status='open' AND ope_id IS NULL` — so it returned 0 against 6 real rows.
 * That is exactly the vocabulary gap OPE-811 closed for `fault_signatures`, and
 * this table shares that vocabulary on purpose (sibling table, one vocabulary).
 *
 * So the fix is on the READ side, as OPE-811 decided: the emitter keeps
 * `proposed`, and eligibility is the canonical FILEABLE set. This tool is the
 * reader, so the rail no longer depends on anyone typing the right literal.
 *
 * ⚠️ FILEABLE is duplicated from `src/lib/faults/status.ts` because this Worker
 * cannot import the main app. `extraction-faults-eligibility-ope463.test.ts`
 * pins the two equal, the same pattern as the hero-proposal action names.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, inArray, isNull, sql } from "drizzle-orm";
import { extractionFaults } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** OPE-811's canonical "still needs filing" set — mirror of isFileableStatus. */
export const EXTRACTION_FAULT_FILEABLE_STATUSES = ["proposed", "regressed", "open"] as const;

/** The eligibility read, as SQL a human or the cpi skill can paste. */
export const EXTRACTION_FAULT_ELIGIBILITY_SQL =
  "SELECT * FROM extraction_faults WHERE status IN ('proposed','regressed','open') AND ope_id IS NULL";

export function registerExtractionFaultTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_extraction_faults",
    [
      "OPE-463 — inbound-extraction fault candidates for the CPI rail.",
      "Default: only FILEABLE rows (status proposed/regressed/open, no ope_id) —",
      "OPE-811's canonical eligibility, so a 'proposed' row is never invisible.",
      "Also returns counts by status and the eligibility SQL. Read-only. Admin only.",
    ].join(" "),
    {
      fileable_only: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ fileable_only, limit }) => {
      const rows = await db
        .select()
        .from(extractionFaults)
        .where(
          fileable_only
            ? and(
                inArray(extractionFaults.status, [...EXTRACTION_FAULT_FILEABLE_STATUSES]),
                isNull(extractionFaults.opeId)
              )
            : undefined
        )
        .orderBy(desc(extractionFaults.lastSeen))
        .limit(limit);

      const byStatus = await db
        .select({ status: extractionFaults.status, n: sql<number>`count(*)` })
        .from(extractionFaults)
        .groupBy(extractionFaults.status);

      return {
        content: [
          jsonContent({
            eligibility_sql: EXTRACTION_FAULT_ELIGIBILITY_SQL,
            by_status: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
            count: rows.length,
            faults: rows,
          }),
        ],
      };
    }
  );
}
