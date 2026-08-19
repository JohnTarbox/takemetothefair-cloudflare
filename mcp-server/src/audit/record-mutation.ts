/**
 * OPE-433 scope 5 — the MCP server's writer for venue / event_day mutation
 * audit rows.
 *
 * Twin of `src/lib/audit/record-mutation.ts`. The rules live in
 * `@takemetothefair/utils` (`buildMutationAudit`) so the two cannot drift into
 * recording different things; app and MCP are separate builds, so the insert
 * itself has to exist twice.
 *
 * MCP writes are the ones this ticket most needs covered: an agent holding the
 * admin token can change a published venue, and before this there was nothing
 * to distinguish that from a cron sweep or an importer.
 */
import { adminActions } from "../schema.js";
import { buildMutationAudit, type MutationAuditInput } from "@takemetothefair/utils";
import type { Db } from "../db.js";

/**
 * Record a mutation to a public-facing row. Best-effort: an audit row must
 * never be able to fail the write it describes.
 *
 * Returns whether a row was written — `false` covers both "nothing changed" and
 * "the insert failed", which the caller should not need to distinguish.
 */
export async function recordMutation(db: Db, input: MutationAuditInput): Promise<boolean> {
  try {
    const row = buildMutationAudit(input, new Date());
    if (!row) return false;
    await db.insert(adminActions).values(row);
    return true;
  } catch {
    return false;
  }
}
