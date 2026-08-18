/**
 * `unsubscribe@` handler — flips newsletter_subscribers.unsubscribed for the
 * from-address, but only when the SENDER asked (OPE-466).
 *
 * Case-insensitive match via LOWER() since emails are case-insensitive
 * per RFC 5321 §2.4 (local-part) and §4.5.3.1.1 (mailbox handling),
 * but the column is stored as-typed.
 *
 * ── Why the write is now conditional ─────────────────────────────────────
 *
 * This used to act on the classifier's verdict alone. Two probe emails during
 * the OPE-455 investigation were classified `unsubscribe` and acked, and the
 * only unsubscribe-shaped text in either was **our own CAN-SPAM footer**,
 * quoted back to us. Nobody was harmed — the probe sender is not a subscriber,
 * so the UPDATE matched 0 rows — but the mechanism was live, and the population
 * it would fire on is real: OPE-407 logs 7 content-free inbound emails whose
 * bodies reduce to boilerplate.
 *
 * So the handler now requires a phrase the sender wrote themselves, with the
 * quoted transcript and the trailing footer removed first
 * (`senderAuthoredText`). The classifier still decides WHICH handler runs; it
 * no longer decides on its own that someone leaves the list.
 *
 * ── Why it still replies when it doesn't act ─────────────────────────────
 *
 * The original docblock argued for acting on a weak signal: *"a sender who got
 * a confirmation they're unsubscribed but is still on the list is the worst
 * case (compliance + trust)."* That is right about the ACK and wrong about the
 * WRITE. Both failures are real and they are mirror images:
 *
 *   ack without removing  — a compliance risk; the sender thinks they are out.
 *   remove without asking — a trust failure, and invisible to the person it
 *                           happens to, since we also tell them it was their idea.
 *
 * The fix is not to pick one. It is to stop making a single reply assert both.
 * A confirmed request gets the removal and the confirmation; an unclear one
 * gets a reply that says plainly we could not tell, and how to be sure — which
 * satisfies the compliance concern without a silent write.
 *
 * Idempotent either way: if the sender isn't in newsletter_subscribers, the
 * UPDATE matches 0 rows and we still ack.
 *
 * Failure handling: D1 errors propagate as plain Error so the workflow's
 * dispatch step retries. Persistent failure → workflow records failed +
 * sends generic reply.
 */

import { newsletterSubscribers } from "../schema.js";
import { getDb } from "../db.js";
import { sql } from "drizzle-orm";
import { findUnsubscribeRequest } from "./sender-authored-text.js";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  // OPE-459 — prefer the full body; the excerpt is a 500-char truncation and a
  // short request can sit past the cut.
  const body = row.bodyText ?? row.bodyTextExcerpt ?? "";
  const evidence = findUnsubscribeRequest(body);

  if (!evidence) {
    // Nothing in the sender's own words asked for this. Say so rather than
    // guessing in either direction.
    console.warn(
      `[unsubscribe] no sender-authored request in ${row.id}; replying without unsubscribing`
    );
    return {
      replyKind: "unsubscribe-unclear",
      replyParams: { subject: row.subject ?? "" },
      status: "replied",
    };
  }

  const db = getDb(env.DB);
  await db
    .update(newsletterSubscribers)
    // OPE-389 — the email-reply unsubscribe path. Its sibling is the API route
    // (src/app/api/newsletter/unsubscribe/route.ts); both stamp the time.
    // OPE-466 — and this one records the phrase it acted on.
    .set({ unsubscribed: true, unsubscribedAt: new Date(), unsubscribeEvidence: evidence })
    .where(sql`LOWER(${newsletterSubscribers.email}) = LOWER(${row.fromAddress})`);
  return {
    replyKind: "unsubscribe-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
  };
};
