/**
 * OPE-1609 — a row that says `replied` must have a ledger row behind it.
 *
 * Every automated reply path now leaves one: `sent`, `failed`, or `stubbed` with
 * a reason. So a `replied` row with no ledger row at all means a reply path
 * stopped recording, which is how 7f761f2a read as answered with nothing sent.
 *
 * Runs hourly over rows received 15–75 minutes ago, so each row is examined
 * about once. ⚠️ Keyed on `received_at` because the row has no updated-at: a
 * correction that sat on the 7-day admin decision reaches `replied` after this
 * window and is not checked.
 */
import { and, between, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { logError } from "../logger.js";
import { emailSendLedger, inboundEmails } from "../schema.js";

type Db = ReturnType<typeof getDb>;

export const REPLIED_LEDGER_CHECK_SOURCE = "mcp:inbound:replied-without-ledger";

const MIN_AGE_MS = 15 * 60_000;
const MAX_AGE_MS = 75 * 60_000;
/** Human replies record their own ledger rows through other paths. */
const HUMAN_REPLY_KINDS = ["manual", "external"];

export interface RepliedLedgerCheck {
  examined: number;
  faults: Array<{ id: string; replyKind: string | null }>;
}

export async function findRepliedWithoutLedger(db: Db, now: Date): Promise<RepliedLedgerCheck> {
  const rows = await db
    .select({
      id: inboundEmails.id,
      replyKind: inboundEmails.replyKind,
      ledgerRows: sql<number>`(select count(*) from ${emailSendLedger} where ${emailSendLedger.inboundEmailId} = ${inboundEmails.id})`,
    })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.status, "replied"),
        isNotNull(inboundEmails.replyKind),
        notInArray(inboundEmails.replyKind, HUMAN_REPLY_KINDS),
        between(
          inboundEmails.receivedAt,
          new Date(now.getTime() - MAX_AGE_MS),
          new Date(now.getTime() - MIN_AGE_MS)
        )
      )
    );
  return {
    examined: rows.length,
    faults: rows
      .filter((r) => Number(r.ledgerRows) === 0)
      .map((r) => ({ id: r.id, replyKind: r.replyKind })),
  };
}

/** Logs one error per fault, and one info row per run as proof the check ran. */
export async function runScheduledRepliedLedgerCheck(env: { DB: D1Database }): Promise<void> {
  const db = getDb(env.DB);
  const { examined, faults } = await findRepliedWithoutLedger(db, new Date());
  for (const fault of faults) {
    await logError(env.DB, {
      source: REPLIED_LEDGER_CHECK_SOURCE,
      message: "inbound row says replied but has no email_send_ledger row (OPE-1609)",
      context: { messageRowId: fault.id, replyKind: fault.replyKind },
    });
  }
  await logError(env.DB, {
    level: "info",
    source: REPLIED_LEDGER_CHECK_SOURCE,
    message: `replied-row ledger check: examined ${examined}, faults ${faults.length}`,
  });
}
