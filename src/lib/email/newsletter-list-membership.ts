/**
 * OPE-510 — the audience-list table shipped with no writer on the signup path.
 *
 * `newsletter_list_subscriptions` arrived with OPE-191, whose Scope §1 said in
 * as many words: *"the public signup form is OUT OF SCOPE / deferred per
 * John."* That deferral was right for the VENDOR list at prototype time. But
 * the same increment switched the WEEKEND broadcast from "all confirmed
 * subscribers" to "members of the `weekend` list" — so a deferral scoped to one
 * list silently became a delivery hole on the other.
 *
 * Every one of the original 17 rows carries the identical `created_at`: one
 * backfill, one instant, nothing since. Eight people double-opted-in and
 * received nothing, and it stayed invisible for eleven days because the list
 * had 17 members the morning of the backfill and still had 17 a week later —
 * a number that never moves looks the same as a number nothing writes to.
 *
 * ⚠️ Re-measured 2026-08-23, two days after that backfill: 29 confirmed-active
 * subscribers against 26 on a list. THREE more had already been stranded. The
 * backfill was remediation, not a fix; this is the fix.
 *
 * ── Why membership is written at CONFIRM, not at signup ──────────────────
 *
 * An unconfirmed address has not asked for anything yet. Writing the row at
 * signup would let anyone put any address on a mailing list by typing it into a
 * form, which is what double opt-in exists to prevent. The row is created at
 * the moment consent is proven and never before.
 *
 * ── List-aware, not `'weekend'`-shaped ──────────────────────────────────
 *
 * The ticket asks for the vendor form to be a config change later rather than a
 * second implementation of the same idea, so the list is a parameter with a
 * source-derived default.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { newsletterListSubscriptions, NEWSLETTER_LISTS } from "@/lib/db/schema";
import type { NewsletterList } from "@takemetothefair/db-schema";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Db = any;

/**
 * Which list a signup source belongs to.
 *
 * `footer`, `event-detail` and `blog-post` are the ordinary public paths and
 * all mean the attendee digest. Anything unrecognised also lands on `weekend`:
 * a new public signup surface added later (OPE-317 adds more) must not silently
 * produce a subscriber on NO list — that is this defect's exact shape, and the
 * safe default is the list the person visibly signed up for.
 */
export function listForSource(source: string | null | undefined): NewsletterList {
  return source === "vendor-form" ? "vendor" : "weekend";
}

export interface MembershipResult {
  list: NewsletterList;
  /** True when a row was created or an unsubscribed row was revived. */
  changed: boolean;
}

/**
 * Put a confirmed subscriber on a list, idempotently.
 *
 * Upsert rather than insert: `UNIQUE (subscriber_id, list)` already exists, and
 * a stale confirmation link clicked twice must be benign rather than a 500. The
 * conflict branch also CLEARS `unsubscribed_at`, which is what makes re-opt-in
 * work — a returning subscriber already has a row, and leaving it tombstoned
 * would produce someone `confirmed=1, unsubscribed=0` who still receives
 * nothing. That is the same invisible state this ticket is about, one table
 * over.
 */
export async function addToList(
  db: Db,
  subscriberId: string,
  list: NewsletterList,
  now: Date = new Date()
): Promise<MembershipResult> {
  await db
    .insert(newsletterListSubscriptions)
    .values({
      id: crypto.randomUUID(),
      subscriberId,
      list,
      createdAt: now,
      unsubscribedAt: null,
    })
    .onConflictDoUpdate({
      target: [newsletterListSubscriptions.subscriberId, newsletterListSubscriptions.list],
      set: { unsubscribedAt: null },
    });

  return { list, changed: true };
}

/**
 * Tombstone every list row for a subscriber.
 *
 * Unsubscribing must reach the list table, not only
 * `newsletter_subscribers.unsubscribed`. Without this a resubscribe produces a
 * subscriber who reads active while the broadcast's own query still excludes
 * them — and the canary below would report balanced counts while the mail went
 * nowhere.
 *
 * Scoped to rows that are still live so a second unsubscribe does not rewrite
 * the original timestamp: when someone left is a fact worth keeping.
 */
export async function removeFromAllLists(
  db: Db,
  subscriberId: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .update(newsletterListSubscriptions)
    .set({ unsubscribedAt: now })
    .where(
      and(
        eq(newsletterListSubscriptions.subscriberId, subscriberId),
        isNull(newsletterListSubscriptions.unsubscribedAt)
      )
    );
}

export interface ListBalance {
  confirmed_active: number;
  on_any_list: number;
  orphaned: number;
  balanced: boolean;
}

/**
 * OPE-510 scope 3 — the two counts that must agree.
 *
 * This defect survived eleven days because nothing compared them. It read 26 vs
 * 20 before the backfill, 26 vs 26 after, and 29 vs 26 two days later. A single
 * number on either side is unreadable; the PAIR is the signal.
 *
 * `orphaned` is the actionable figure — it counts people, each of whom
 * double-opted-in and is receiving nothing.
 */
export async function listBalance(db: Db): Promise<ListBalance> {
  const [row] = await db.all(sql`
    SELECT
      (SELECT COUNT(*) FROM newsletter_subscribers
        WHERE confirmed = 1 AND unsubscribed = 0) AS confirmed_active,
      (SELECT COUNT(DISTINCT subscriber_id) FROM newsletter_list_subscriptions
        WHERE unsubscribed_at IS NULL) AS on_any_list,
      (SELECT COUNT(*) FROM newsletter_subscribers s
        WHERE s.confirmed = 1 AND s.unsubscribed = 0
          AND NOT EXISTS (
            SELECT 1 FROM newsletter_list_subscriptions l
             WHERE l.subscriber_id = s.id AND l.unsubscribed_at IS NULL
          )) AS orphaned
  `);

  const confirmedActive = Number(row?.confirmed_active ?? 0);
  const onAnyList = Number(row?.on_any_list ?? 0);
  const orphaned = Number(row?.orphaned ?? 0);
  return {
    confirmed_active: confirmedActive,
    on_any_list: onAnyList,
    orphaned,
    balanced: orphaned === 0,
  };
}

/** Exported so a caller cannot re-spell the list names. */
export const KNOWN_LISTS = NEWSLETTER_LISTS;
