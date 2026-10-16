/**
 * OPE-1374 — the ONE thing a best-effort audit-row catch does.
 *
 * An `admin_actions` (or other provenance) insert must never fail the write it
 * describes, so those inserts sit in a try/catch. Before this, the catch was a
 * comment and nothing else: the audit row vanished with no trace, which is the
 * project's most frequent defect class (success reported, work not done). The
 * catch now records an `error_logs` row naming the action and the target, so a
 * persistent audit-write failure surfaces through the fault ledger.
 *
 * Twin of `src/lib/audit/log-audit-failure.ts` (separate builds). Never throws:
 * `logError` swallows its own D1 failure.
 */
import { logError } from "../logger.js";
import type { Db } from "../db.js";

export interface AuditFailure {
  /** error_logs source, `mcp:<area>[:<sub>]` (e.g. `mcp:tool:merge_vendor`). */
  source: string;
  /** The audit row that was lost — e.g. `vendor.merge`, `vendor_slug_history`. */
  action: string;
  targetType?: string;
  targetId?: string | null;
  error: unknown;
}

export async function logAuditWriteFailure(
  db: Db | D1Database | null | undefined,
  f: AuditFailure
): Promise<void> {
  await logError(db, {
    source: f.source,
    message: `Audit write failed (${f.action}); the change it describes was kept`,
    error: f.error,
    context: {
      auditAction: f.action,
      targetType: f.targetType ?? null,
      targetId: f.targetId ?? null,
    },
  });
}
