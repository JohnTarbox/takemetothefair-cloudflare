/**
 * OPE-1173 — `link_fault_family` + `find_fault_family`: stamp the
 * `fault_signatures` ledger from ANY agent, not only the OPE-84 scan.
 *
 * `fault_signatures.ope_id` is how the scan knows a fault is already filed, and
 * until now only the scan's own raw D1 UPDATE (its Step 4) ever wrote it. A
 * ticket filed by anything else — a review pass, the queue runner, a
 * human-directed session — left its rows `ope_id NULL`, reading as unfiled:
 *
 *   - OPE-1128 was filed and fixed on 2026-09-23; its 57 rows stayed unlinked,
 *     so the next scan filed OPE-1149 for the same crash (closed as duplicate).
 *   - OPE-1031, a regression of OPE-314, was invisible to the regression arm
 *     because OPE-314's row had never been linked.
 *
 * `cpi_record_filing` solved this for the CPI ledger; this is its sibling.
 *
 * ── Status written on link: `filed`, not `open` ─────────────────────────────
 *
 * The scan's Step 4 SQL writes `open`. But the canonical vocabulary
 * (src/lib/faults/status.ts) defines `open` as a FILEABLE status — "a live
 * candidate that still needs filing" — and the code's own transition for this
 * exact act writes `filed` (src/app/api/internal/faults/record-candidate).
 * Either is safe from re-proposal today, because the reconciler treats any row
 * carrying an `ope_id` as existing (src/lib/faults/reconcile.ts). The default
 * follows the vocabulary rather than the literal; `status: "open"` is accepted
 * for a caller that wants the scan's spelling.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { containsCI } from "@takemetothefair/db-schema";
import { faultSignatures, type FaultSignatureRow } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export const LINK_STATUSES = ["filed", "open"] as const;

export interface LinkFaultFamilyInput {
  opeId: string;
  errorClass?: string;
  signature?: string;
  /** Re-point: move ONLY rows currently carrying this OPE id. */
  fromOpeId?: string;
  status?: (typeof LINK_STATUSES)[number];
  now?: Date;
}

export interface LinkFaultFamilyResult {
  matched: number;
  updated: number;
  /** Rows the call did not change because they carry an ope_id (any, including this one). */
  already_linked: Array<{ signature: string; ope_id: string }>;
  mode: "link" | "repoint";
  status: string;
}

export async function linkFaultFamily(
  db: Db,
  input: LinkFaultFamilyInput
): Promise<LinkFaultFamilyResult> {
  const { opeId, errorClass, signature, fromOpeId } = input;
  const status = input.status ?? "filed";
  const now = input.now ?? new Date();

  const selector: SQL[] = [];
  if (errorClass) selector.push(eq(faultSignatures.errorClass, errorClass));
  if (signature) selector.push(eq(faultSignatures.signature, signature));
  if (fromOpeId) selector.push(eq(faultSignatures.opeId, fromOpeId));
  if (selector.length === 0) throw new Error("need error_class, signature or from_ope_id");
  const where = and(...selector);

  const before = await db
    .select({ signature: faultSignatures.signature, opeId: faultSignatures.opeId })
    .from(faultSignatures)
    .where(where);

  let updated: number;
  if (fromOpeId) {
    // Duplicate closure (OPE-1149 → OPE-1128): exactly the rows carrying
    // `fromOpeId`, whatever their status. filed_at is kept — the family was
    // filed when it was filed; only the ticket it points at changes.
    const res = await db
      .update(faultSignatures)
      .set({ opeId })
      .where(where)
      .returning({ signature: faultSignatures.signature });
    updated = res.length;
    return {
      matched: before.length,
      updated,
      already_linked: [],
      mode: "repoint",
      status: "(unchanged)",
    };
  }

  // Link: only rows with no ope_id. A DIFFERENT non-null ope_id is never
  // overwritten — that would silently re-attribute another ticket's family.
  const res = await db
    .update(faultSignatures)
    // The Drizzle enum still names only the code's four statuses; prod also
    // holds the agent statuses OPE-811 kept on purpose (src/lib/faults/status.ts).
    .set({ opeId, filedAt: now, status: status as FaultSignatureRow["status"] })
    .where(and(where, isNull(faultSignatures.opeId)))
    .returning({ signature: faultSignatures.signature });
  updated = res.length;

  return {
    matched: before.length,
    updated,
    already_linked: before
      .filter((r) => r.opeId != null)
      .map((r) => ({ signature: r.signature, ope_id: r.opeId as string })),
    mode: "link",
    status,
  };
}

export interface FaultFamily {
  error_class: string;
  signatures: number;
  total_count: number;
  last_seen: Date | null;
  statuses: string;
  ope_ids: string | null;
  unlinked: number;
}

export async function findFaultFamily(
  db: Db,
  query: string,
  limit: number
): Promise<FaultFamily[]> {
  const rows = await db
    .select({
      error_class: faultSignatures.errorClass,
      signatures: sql<number>`count(*)`,
      total_count: sql<number>`sum(${faultSignatures.count})`,
      last_seen: sql<number>`max(${faultSignatures.lastSeen})`,
      statuses: sql<string>`group_concat(distinct ${faultSignatures.status})`,
      ope_ids: sql<string | null>`group_concat(distinct ${faultSignatures.opeId})`,
      unlinked: sql<number>`sum(case when ${faultSignatures.opeId} is null then 1 else 0 end)`,
    })
    .from(faultSignatures)
    // containsCI, never a LIKE built from input: D1 caps a LIKE pattern at 50
    // bytes, and error classes are often longer than that.
    .where(containsCI(faultSignatures.errorClass, query))
    .groupBy(faultSignatures.errorClass)
    .orderBy(desc(sql`max(${faultSignatures.lastSeen})`))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    signatures: Number(r.signatures),
    total_count: Number(r.total_count),
    unlinked: Number(r.unlinked),
    last_seen: r.last_seen == null ? null : new Date(Number(r.last_seen) * 1000),
  }));
}

export function registerFaultFamilyTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "link_fault_family",
    [
      "OPE-1173 — stamp the fault_signatures ledger with the OPE that covers it.",
      "CALL THIS IMMEDIATELY AFTER creating a Linear issue for any fault that appears",
      "in fault_signatures, and after closing one fault ticket as a duplicate of",
      "another. Skipping it leaves the rows looking unfiled: the OPE-84 scan then files",
      "a duplicate (OPE-1149), and a later regression is invisible (OPE-1031).",
      "",
      "Select rows with exactly one of `error_class` (the whole family) or `signature`",
      "(one row). Only rows with NO ope_id are changed; a row already carrying an",
      "ope_id — this one or another — is never overwritten and is reported in",
      "`already_linked`. Linked rows get status `filed` (or `open` if asked).",
      "",
      "Duplicate closure: pass `from_ope_id` (the closed duplicate) and `ope_id` (the",
      "keeper). Exactly the rows carrying `from_ope_id` move; nothing else is touched.",
      "Use find_fault_family to find the error_class. Idempotent. Admin only.",
    ].join(" "),
    {
      ope_id: z.string().min(1).max(64).describe("The OPE that covers the fault, e.g. 'OPE-1128'."),
      error_class: z.string().min(1).max(500).optional(),
      signature: z.string().min(1).max(256).optional(),
      from_ope_id: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Re-point mode: move only rows currently carrying this OPE id."),
      status: z.enum(LINK_STATUSES).optional(),
    },
    async ({ ope_id, error_class, signature, from_ope_id, status }) => {
      if (error_class && signature) {
        return {
          content: [jsonContent({ error: "pass error_class OR signature, not both" })],
          isError: true,
        };
      }
      if (!error_class && !signature && !from_ope_id) {
        return {
          content: [jsonContent({ error: "need error_class, signature or from_ope_id" })],
          isError: true,
        };
      }
      if (from_ope_id && from_ope_id === ope_id) {
        return {
          content: [jsonContent({ error: "from_ope_id and ope_id are the same" })],
          isError: true,
        };
      }
      const result = await linkFaultFamily(db, {
        opeId: ope_id,
        errorClass: error_class,
        signature,
        fromOpeId: from_ope_id,
        status,
      });
      return { content: [jsonContent(result)] };
    }
  );

  server.tool(
    "find_fault_family",
    [
      "OPE-1173 — find the fault_signatures family (error_class) matching some text,",
      "so a ticket filed from an error_logs row can be linked with link_fault_family",
      "without writing SQL. Case-insensitive substring match on error_class; returns",
      "one row per family with its signature count, total occurrences, statuses, the",
      "OPE ids already linked and how many rows are still unlinked. Read-only. Admin only.",
    ].join(" "),
    {
      query: z.string().min(2).max(500),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ query, limit }) => {
      const families = await findFaultFamily(db, query, limit);
      return { content: [jsonContent({ count: families.length, families })] };
    }
  );
}
