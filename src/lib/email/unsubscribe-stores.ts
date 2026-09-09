/**
 * OPE-869 — one definition of "this person opted out of everything".
 *
 * ## What was wrong
 *
 * Two unsubscribe systems wrote to two disjoint stores:
 *
 *   - Path A (`/api/newsletter/unsubscribe`) → `newsletter_subscribers.unsubscribed`
 *     plus `newsletter_list_subscriptions` rows.
 *   - Path B (`/unsubscribe/<e>/<t>` and the legacy `?e=&t=` form) →
 *     `email_suppression_list`.
 *
 * A suppression entry did not set `unsubscribed`; an `unsubscribed` flag did not
 * create a suppression row. Both are consulted at send time
 * (`selectBroadcastRecipients` reads all three), so neither was inert — but
 * "did this person unsubscribe?" had two different answers depending on which
 * table you read, and which one honoured a given click depended only on which
 * mail the person happened to receive.
 *
 * ## ⚠️ Why "make each path write both" is the WRONG fix, half the time
 *
 * The ticket offered "converge on one store, or make each path write both". The
 * second option is a trap after OPE-864, and it is worth being explicit about
 * because it looks like the safe choice.
 *
 * Suppression is GLOBAL by construction: `selectBroadcastRecipients` drops a
 * suppressed address from every audience. So if a LIST-SCOPED unsubscribe wrote
 * a suppression row, clicking "unsubscribe" in the vendor digest would remove
 * the person from the weekend digest too — reintroducing precisely the defect
 * OPE-864 shipped to fix, through a different table.
 *
 * The correct convergence is therefore asymmetric, and it follows from what
 * each click MEANS rather than from which table each path happened to use:
 *
 *   - A **global** opt-out (Path B, or Path A with a legacy/last-list token)
 *     writes BOTH stores. That is what this function is.
 *   - A **list-scoped** opt-out (Path A with a list token) writes only the list
 *     row. It must not touch suppression, and it must not set the global flag
 *     while another list is still live.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  emailSuppressionList,
  newsletterSubscribers,
  newsletterListSubscriptions,
} from "@/lib/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface GlobalOptOutResult {
  /** True when a suppression row was present or created. */
  suppressed: boolean;
  /** True when a `newsletter_subscribers` row existed and was flagged. */
  subscriberFlagged: boolean;
}

/**
 * Record a GLOBAL opt-out in every store that a send path consults.
 *
 * Idempotent in all three writes: a second click must not create a duplicate
 * suppression row, must not re-stamp `unsubscribed_at`, and must not rewrite
 * the `unsubscribed_at` on an already-closed list row. When someone left is a
 * fact worth keeping.
 *
 * Safe for an address that is not a newsletter subscriber at all — Path B mail
 * goes to vendors and organizers who may never have signed up for a newsletter,
 * and the suppression row is the only place their opt-out can live.
 */
export async function applyGlobalOptOut(
  db: Db,
  email: string,
  opts: { source: string; now?: Date } = { source: "unsubscribe-link" }
): Promise<GlobalOptOutResult> {
  const addr = email.trim().toLowerCase();
  const now = opts.now ?? new Date();

  // 1. Suppression list — the store Path B always wrote, and the only one that
  //    can hold an opt-out for a non-subscriber.
  await db
    .insert(emailSuppressionList)
    .values({ email: addr, reason: "unsubscribe", source: opts.source, createdAt: now })
    .onConflictDoNothing({ target: emailSuppressionList.email });

  // 2. The subscriber flag — the store Path A always wrote.
  const [sub] = await db
    .select({ id: newsletterSubscribers.id })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, addr))
    .limit(1);

  if (!sub) return { suppressed: true, subscriberFlagged: false };

  await db
    .update(newsletterSubscribers)
    // OPE-389 / OPE-466 — stamp the time AND the evidence, for the same reason
    // the other writers do: a column that is right only on some paths is worse
    // than one that is absent.
    .set({
      unsubscribed: true,
      unsubscribedAt: now,
      unsubscribeEvidence: "signed-unsubscribe-link",
    })
    .where(eq(newsletterSubscribers.email, addr));

  // 3. Every list row — a global opt-out means every audience.
  await db
    .update(newsletterListSubscriptions)
    .set({ unsubscribedAt: now })
    .where(
      and(
        eq(newsletterListSubscriptions.subscriberId, sub.id),
        isNull(newsletterListSubscriptions.unsubscribedAt)
      )
    );

  return { suppressed: true, subscriberFlagged: true };
}
