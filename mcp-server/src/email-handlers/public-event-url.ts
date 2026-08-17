/**
 * OPE-431 — never put a public event URL in an outbound email unless the row
 * is actually publicly visible.
 *
 * ---------------------------------------------------------------------------
 * What happened
 * ---------------------------------------------------------------------------
 *
 * A `submit@` acknowledgment told a member of the public that their event was
 * "already in our directory" and linked
 * `https://meetmeatthefair.com/events/<slug>`. The matched row was `PENDING`
 * — created by that same email seconds earlier — so the link had never
 * resolved. The submitter clicked it and got a 404.
 *
 * A slug is not a URL guarantee. Only a publicly-visible status is.
 * `/events/[slug]` gates on the public-status check, so a link to a PENDING,
 * REJECTED, or merge-tombstoned row is a 404 by construction. Tombstones are
 * worse than a 404: `merge_events` renames the loser's slug to
 * `<orig>-merged-<id8>`, so an already-sent link dies later.
 *
 * ---------------------------------------------------------------------------
 * Why this is a shared helper and not an inline check
 * ---------------------------------------------------------------------------
 *
 * The check ALREADY EXISTED. `email-reply-builder.ts` has it in the
 * single-event `already-exists` branch, with a comment spelling out the exact
 * 404 this ticket reports. It was simply never applied to the two `ok-multi`
 * renderers in the workflow, which build the same bullet independently.
 *
 * That is [[feedback_fix_wired_into_one_of_two_parallel_paths]] almost
 * verbatim — so the fix is one definition every caller imports, rather than a
 * third copy of the same conditional waiting to drift.
 */

/**
 * Statuses whose `/events/<slug>` page actually renders for an anonymous
 * visitor. Mirrors PUBLIC_EVENT_STATUSES; kept as an explicit local set
 * because this is a "may we email this link" decision, and it should fail
 * closed if the visibility rules are ever widened for some other reason.
 *
 * CONFIRMED is included because the pre-existing single-event branch accepted
 * it; dropping it here would silently narrow behaviour that already shipped.
 */
const EMAILABLE_STATUSES = new Set(["APPROVED", "CONFIRMED"]);

export function isEmailableEventStatus(status: string | null | undefined): boolean {
  return !!status && EMAILABLE_STATUSES.has(status);
}

/**
 * The public URL for an event, or null when it must not be linked.
 *
 * Returns null rather than throwing: an outbound email that fails to send is
 * worse than one that omits a link, and every caller has sensible wording for
 * the no-link case.
 */
export function publicEventUrlIfVisible(
  slug: string | null | undefined,
  status: string | null | undefined
): string | null {
  if (!slug) return null;
  if (!isEmailableEventStatus(status)) return null;
  return `https://meetmeatthefair.com/events/${slug}`;
}

/**
 * The `ok-multi` bullet for an event the dedup matched against an existing row.
 *
 * Two things the old wording got wrong, both fixed here:
 *
 *   1. It linked unconditionally. Now the URL appears only when the row is
 *      publicly visible.
 *   2. It said "already in our directory" for a row that was not in the
 *      directory — it was PENDING, and in the reported case had been created
 *      by the same email seconds earlier. That is a false statement to a
 *      member of the public, not just a broken link. A row still in review is
 *      described as such.
 */
export function alreadyExistsBullet(
  eventName: string | undefined,
  slug: string | null | undefined,
  status: string | null | undefined
): string {
  const name = eventName ?? "this event";
  const url = publicEventUrlIfVisible(slug, status);
  if (url) return `✅ "${name}" — already in our directory: ${url}`;
  // No link, and no claim of directory membership: this row is not published.
  return `✅ "${name}" — we already have this one; it's in review and will go live once approved`;
}
