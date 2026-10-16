/**
 * OPE-1374 — the ONE thing a best-effort audit-row catch does.
 *
 * An `admin_actions` insert must never fail the write it describes, so those
 * inserts sit in a try/catch. Before this, the catch was a comment and nothing
 * else: the audit row vanished with no trace. The catch now records an
 * `error_logs` row naming the action and the target, so a persistent
 * audit-write failure surfaces through the fault ledger.
 *
 * Twin of `mcp-server/src/audit/log-audit-failure.ts` (separate builds).
 * Never throws: `logError` swallows its own D1 failure.
 */
import { logError } from "@/lib/logger";

export interface AuditFailure {
  /** error_logs source, e.g. `admin:duplicates:merge`. */
  source: string;
  /** The audit row that was lost — e.g. `promoter.merge`. */
  action: string;
  targetType?: string;
  targetId?: string | null;
  error: unknown;
}

export async function logAuditWriteFailure(db: unknown, f: AuditFailure): Promise<void> {
  await logError(db as Parameters<typeof logError>[0], {
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
