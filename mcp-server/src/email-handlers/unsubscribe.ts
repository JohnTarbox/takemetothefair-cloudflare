/**
 * `unsubscribe@` handler — actually flips
 * newsletter_subscribers.unsubscribed = true for the from-address.
 *
 * Idempotent by design: if the sender isn't in newsletter_subscribers,
 * the UPDATE matches 0 rows but we still send the ack. The sender's
 * intent is "stop emailing me" — confirming that we have nothing to
 * stop is the same outcome as flipping a flag.
 *
 * Case-insensitive match via LOWER() since emails are case-insensitive
 * per RFC 5321 §2.4 (local-part) and §4.5.3.1.1 (mailbox handling),
 * but the column is stored as-typed.
 */

import { newsletterSubscribers } from "../schema.js";
import { getDb } from "../db.js";
import { sql } from "drizzle-orm";
import { logError } from "../logger.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE = "mcp:email-handler:unsubscribe";

export const handle: HandlerFn = async (env, ctx, row): Promise<HandlerResult> => {
  try {
    const db = getDb(env.DB);
    await db
      .update(newsletterSubscribers)
      .set({ unsubscribed: true })
      .where(sql`LOWER(${newsletterSubscribers.email}) = LOWER(${row.fromAddress})`);
    return {
      replyKind: "unsubscribe-ack",
      replyParams: { subject: row.subject ?? "" },
      status: "replied",
    };
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "failed to update newsletter_subscribers for unsubscribe",
      error: err,
      sessionId: ctx.sessionId,
      context: { inboundEmailId: row.id, from: row.fromAddress },
    });
    // Still ack — the user's intent was to opt out, and we don't want
    // them retrying because we 500'd on our end. Admin will see the
    // logged error and can fix manually.
    return {
      replyKind: "unsubscribe-ack",
      replyParams: { subject: row.subject ?? "" },
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
