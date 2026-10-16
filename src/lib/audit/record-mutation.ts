/**
 * OPE-433 scope 5 — the app's writer for venue / event_day mutation audit rows.
 *
 * The rules live in `@takemetothefair/utils` (`buildMutationAudit`) so this and
 * its MCP twin cannot drift into recording different things. This file is only
 * the insert.
 *
 * Best-effort by construction: an audit row must never be able to fail the
 * write it describes. A venue that saved but whose audit row threw is a worse
 * outcome than a venue that saved unaudited, and the caller has usually already
 * committed by the time we get here.
 */
import { adminActions } from "@/lib/db/schema";
import { buildMutationAudit, type MutationAuditInput } from "@takemetothefair/utils";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { logAuditWriteFailure } from "@/lib/audit/log-audit-failure";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Record a mutation to a public-facing row.
 *
 * Returns whether a row was written — `false` covers both "nothing changed"
 * (a no-op update) and "the insert failed", which the caller should not need to
 * distinguish: neither is a reason to alter what it does next.
 */
export async function recordMutation(db: Db, input: MutationAuditInput): Promise<boolean> {
  try {
    const row = buildMutationAudit(input, new Date());
    if (!row) return false;
    await db.insert(adminActions).values(row);
    return true;
  } catch (error) {
    // Still best-effort (never fails the write it describes), but no longer
    // silent: the lost row is logged with the entity it described (OPE-1374).
    await logAuditWriteFailure(db, {
      source: "audit:record-mutation",
      action: `${input.entityType}.${input.verb}`,
      targetType: input.entityType,
      targetId: input.entityId,
      error,
    });
    return false;
  }
}
