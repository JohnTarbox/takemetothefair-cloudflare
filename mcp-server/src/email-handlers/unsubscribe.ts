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
 *
 * Failure handling: D1 errors propagate as plain Error so the workflow's
 * dispatch step retries. Persistent failure → workflow records failed +
 * sends generic reply. We chose this over "always ack" because a sender
 * who got a confirmation they're unsubscribed but is still on the list
 * is the worst case (compliance + trust).
 */

import { newsletterSubscribers } from "../schema.js";
import { getDb } from "../db.js";
import { sql } from "drizzle-orm";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
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
};
