/** Equals UPCOMING_END_GRACE_MS in `@/lib/event-dates` — pinned by test. */
export const PAST_UNCONFIRMED_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * OPE-1098 (John, 2026-09-23: Option C, display-only) — a TENTATIVE event whose
 * date has passed.
 *
 * The data stays TENTATIVE: promoting it to OCCURRED asserts a claim nobody
 * made (OPE-675's standing ruling). What changes is only how it PRESENTS — a
 * finished event must not keep reading as an unconfirmed FUTURE one.
 *
 * TENTATIVE either way counts: editorial `status` (what the badge and banner
 * read) or `lifecycle_status` (what the JSON-LD reads) — the stuck population
 * was 198 lifecycle-only rows plus 40 editorial ones.
 *
 * "Past" is the listing's own rule (`upcomingEndPredicate`): the end date, or
 * the START date when there is no end (36 of the stuck rows have none), plus
 * the same 24h end-of-day grace — so a page and the list it was reached from
 * can never disagree about whether an event is over.
 *
 * DEPENDENCY-FREE on purpose: the card and list views are client components,
 * and `event-dates`/`event-lifecycle` import drizzle and the DB schema.
 */
export function isPastUnconfirmed(
  e: {
    status?: string | null;
    lifecycleStatus?: string | null;
    startDate?: Date | string | number | null;
    endDate?: Date | string | number | null;
  },
  now: Date = new Date()
): boolean {
  if (e.status !== "TENTATIVE" && e.lifecycleStatus !== "TENTATIVE") return false;
  const last = e.endDate ?? e.startDate;
  if (last === null || last === undefined) return false;
  const t = new Date(last).getTime();
  if (Number.isNaN(t)) return false;
  return t < now.getTime() - PAST_UNCONFIRMED_GRACE_MS;
}

/** The one public label for it, so the badge and banner can't drift. */
export const PAST_UNCONFIRMED_LABEL = "Past event — never confirmed";
