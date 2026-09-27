/**
 * OPE-1172 — is this address known to be unable to receive mail?
 *
 * A registration email to a mistyped address hard-bounces within seconds, and
 * Cloudflare then suppresses the address. On 2026-09-26 the user asked for the
 * verification email again 13 minutes later; we sent it anyway, the provider
 * rejected it, the queue retried the rejection 4× and parked it in the DLQ,
 * and the user was shown "Check your inbox". About 3% of registration emails
 * hard-bounce (4 of 161 `auth.register` since 2026-08-17), and each is a
 * signup that can never verify unless someone tells them the address is wrong.
 *
 * Two stores answer the question, and either is sufficient:
 *
 *   email_suppression_list  reason 'bounce' | 'complaint' — written by the
 *                           delivery-event consumer on a HARD bounce or a
 *                           complaint (mcp-server/src/email-delivery.ts,
 *                           `shouldSuppress`). 'unsubscribe' / 'manual' are
 *                           marketing opt-outs and must NOT block a
 *                           transactional verification or reset email.
 *   email_send_ledger       the newest row for this recipient that carries a
 *                           delivery outcome. Checked as well because the
 *                           ledger update and the suppression insert are two
 *                           separate writes; a later DELIVERED outcome clears it.
 *
 * Lives here, not in one route, so every transactional re-send path asks the
 * same question (OPE-1172 scope 4).
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { emailSendLedger, emailSuppressionList } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** Suppression reasons that mean "mail cannot arrive", as opposed to "do not market". */
export const UNDELIVERABLE_SUPPRESSION_REASONS = ["bounce", "complaint"] as const;

/** Pure: does a ledger delivery outcome mean the address is dead? */
export function isUndeliverableOutcome(
  deliveryStatus: string | null | undefined,
  deliveryDetail: string | null | undefined
): boolean {
  if (deliveryStatus === "complained") return true;
  if (deliveryStatus !== "bounced") return false;
  try {
    const detail = JSON.parse(deliveryDetail ?? "{}") as { bounceType?: unknown };
    return String(detail.bounceType ?? "").toLowerCase() === "hard";
  } catch {
    return false;
  }
}

export async function isAddressUndeliverable(db: Db, rawEmail: string): Promise<boolean> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return false;

  const suppressed = await db
    .select({ email: emailSuppressionList.email })
    .from(emailSuppressionList)
    .where(
      and(
        eq(emailSuppressionList.email, email),
        inArray(emailSuppressionList.reason, [...UNDELIVERABLE_SUPPRESSION_REASONS])
      )
    )
    .limit(1);
  if (suppressed.length > 0) return true;

  const latest = await db
    .select({
      status: emailSendLedger.deliveryStatus,
      detail: emailSendLedger.deliveryDetail,
    })
    .from(emailSendLedger)
    .where(
      and(
        sql`lower(${emailSendLedger.recipient}) = ${email}`,
        isNotNull(emailSendLedger.deliveryStatus)
      )
    )
    .orderBy(desc(emailSendLedger.deliveryUpdatedAt))
    .limit(1);

  return latest.length > 0 && isUndeliverableOutcome(latest[0].status, latest[0].detail);
}
