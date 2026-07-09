/**
 * OPE-151 — the single MCP-side choke point for recording outbound email in
 * email_send_ledger. Every MCP send site (the EMAIL_JOBS queue consumer AND the
 * inbound-email workflow's direct auto-reply) writes exactly one row per send
 * attempt through here, so "did we email X, and did it go out?" is answerable
 * and failures are visible. The main app has its own equivalent inside
 * src/lib/email/send.ts (separate runtime — no shared code).
 *
 * "Did we email X?" — query email_send_ledger by `recipient` (and optionally
 * `status`); each row carries source/subject/provider/provider_message_id/
 * status/error, and `inbound_email_id` links an auto-reply back to the inbound
 * email that triggered it. Rows are retained ~1 year (see EMAIL_LEDGER_TTL in
 * queue-consumers.ts). The OPE-152 admin Email viewer is the UI over this table.
 */
import { eq } from "drizzle-orm";
import { emailSendLedger } from "./schema.js";
import type { Db } from "./db.js";

export type LedgerStatus = "sent" | "failed" | "stubbed";

export interface LedgerEntry {
  /** Idempotency/audit key: queue message id, or `reply-<inboundId>` etc. */
  messageId: string;
  recipient?: string | null;
  source?: string | null;
  subject?: string | null;
  status: LedgerStatus;
  provider?: string | null; // 'cf-email' | 'resend' | 'stub'
  providerMessageId?: string | null;
  error?: string | null;
  inboundEmailId?: string | null;
  /** OPE-155 — the rendered body that went out (for the admin Sent viewer). */
  bodyHtml?: string | null;
  bodyText?: string | null;
}

/**
 * Upsert one ledger row per send attempt, keyed on messageId. A redelivery that
 * finally succeeds overwrites an earlier 'failed' for the same id. Best-effort —
 * a ledger write must NEVER break mail delivery, so all errors are swallowed.
 */
export async function ledgerEmailSend(db: Db, e: LedgerEntry): Promise<void> {
  const row = {
    sentAt: new Date(),
    recipient: e.recipient ?? null,
    source: e.source ?? null,
    providerMessageId: e.providerMessageId ?? null,
    status: e.status,
    error: e.error ?? null,
    subject: e.subject ?? null,
    inboundEmailId: e.inboundEmailId ?? null,
    provider: e.provider ?? null,
    bodyHtml: e.bodyHtml ?? null,
    bodyText: e.bodyText ?? null,
  };
  try {
    await db
      .insert(emailSendLedger)
      .values({ messageId: e.messageId, ...row })
      .onConflictDoUpdate({ target: emailSendLedger.messageId, set: row });
  } catch {
    /* ledger is best-effort — never block delivery on an audit-write hiccup */
  }
}

/** True only if this message id was already SENT (status='sent'). A 'failed'
 *  row does not count, so a retry is never blocked by a prior failed attempt. */
export async function wasEmailSent(db: Db, messageId: string): Promise<boolean> {
  const rows = await db
    .select({ status: emailSendLedger.status })
    .from(emailSendLedger)
    .where(eq(emailSendLedger.messageId, messageId))
    .limit(1);
  return rows.length > 0 && rows[0].status === "sent";
}
