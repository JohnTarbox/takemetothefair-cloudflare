/**
 * "Is this a real person, or an ingestion placeholder?" — in one place.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Measured against prod 2026-08-31:
 *
 *     total users .................. 7,878
 *     `pending+…@` placeholders .... 7,577   (96.2%)
 *     real users ...................   301
 *
 * **Any raw user count is inflated roughly 26x.** The placeholders are minted by
 * the ingestion pipeline so an imported vendor/promoter/performer row has an
 * owner FK to point at. They hold no session, never verify an email, and nobody
 * ever signed up. They are legitimate rows and must not be deleted — but they
 * are not people, and counting them as people has produced wrong answers
 * repeatedly:
 *
 *   OPE-697  "717 promoters need a claims backfill" — 716 were placeholders and
 *            the true population was ZERO.
 *   OPE-703  "717 unverified promoter accounts can create events" — all
 *            placeholders with no session; the 6 real ones were already verified.
 *
 * In both cases the raw number argued for a bulk mutation that would have been
 * wrong, and the cohort split made it evaporate.
 *
 * ── The two signals agree exactly, and both are checked anyway ────────────
 *
 * `origin = 'ingestion'` and `email LIKE 'pending+%'` partition the table
 * identically — measured across all 7,878 rows, ZERO rows satisfy one and not
 * the other. So either would do today.
 *
 * This checks BOTH, deliberately. `origin` is the semantic column (OPE-292) and
 * the one to prefer, but the data-health report already carries a
 * `misfiled_placeholders` probe precisely because a creation path can stop
 * stamping it — and on the day that happens, the email shape is the fallback
 * that keeps the count honest. Two cheap predicates, no drift.
 *
 * ── What this is NOT for ──────────────────────────────────────────────────
 *
 * Point lookups. Fetching a user by id or email to authenticate, claim, or send
 * to must NOT filter placeholders out — the row is real and the FK is real. This
 * is for AGGREGATES and LISTINGS, where the question is "how many people" or
 * "show me the people".
 */
import { and, ne, notLike, sql, type SQL } from "drizzle-orm";
import { users } from "./index";

/**
 * ⚠️ There is no in-memory counterpart here on purpose.
 *
 * One was written and REMOVED the same day (OPE-726): nothing called it, and
 * "a caller might want it later" is exactly the reason this codebase has
 * shipped fully-tested predicates that nothing ever invoked. For a row already
 * in hand, use `isPlaceholderEmail` from `@takemetothefair/utils` (the OPE-293
 * authority on the address shape, which also checks the domain) together with
 * an `origin === "ingestion"` check at the call site.
 */
export const PLACEHOLDER_EMAIL_PREFIX = "pending+";

/** The `users.origin` value the ingestion pipeline stamps (OPE-292). */
export const PLACEHOLDER_ORIGIN = "ingestion";

/**
 * Drizzle WHERE fragment selecting only real people.
 *
 * ⚠️ `coalesce` on both columns: `origin` is nullable on older rows, and in SQL
 * `NULL <> 'ingestion'` is NULL — so an un-stamped legacy row would fail the
 * filter and vanish from every count that uses this. That is the same negated-
 * comparison trap that has bitten `isNonResearchCategory` and the OPE-713
 * producer-class predicate, and it fails in the direction that looks like a
 * smaller, tidier number.
 */
export function realUserWhere(): SQL {
  return and(
    ne(sql`coalesce(${users.origin}, '')`, PLACEHOLDER_ORIGIN),
    notLike(sql`coalesce(${users.email}, '')`, `${PLACEHOLDER_EMAIL_PREFIX}%`)
  ) as SQL;
}
