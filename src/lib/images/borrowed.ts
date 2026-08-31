/**
 * OPE-294 — "is this image ours?", as a SQL pre-filter.
 *
 * `classifyImageHost` (packages/utils) is the AUTHORITY on that question and
 * runs per row in TypeScript. These predicates exist only because a sweep has
 * to narrow a table before it can classify anything, and a query cannot call
 * the classifier. They are deliberately coarse: the only property they must
 * have is that they never exclude a row the classifier would accept.
 *
 * They live here rather than inline in the route handlers for two reasons. The
 * events sweep's GET progress endpoint promises it "mirrors the POST SELECT
 * exactly so `remaining` matches what the next POST will actually pick up", and
 * it kept that promise by RESTATING the predicate — so widening the POST alone
 * would have turned the progress number into a quiet lie. And a route file
 * cannot export a helper for a test to import without Next.js objecting, which
 * is how an untested predicate happens.
 *
 * ⚠️ On the IFNULL wrappers, stated accurately. In SQLite `NULL NOT LIKE 'x'`
 * evaluates to NULL rather than true, so an unwrapped negated LIKE drops every
 * NULL row — a defect this codebase has shipped before. Here the wrappers are
 * DEFENCE IN DEPTH, not load-bearing: `ogSweepCandidatePredicate` already
 * admits null images through its `isNull` branch, and `borrowedImage` already
 * excludes them via `isNotNull`, so removing the IFNULLs today changes no
 * result. That was measured, not assumed — the mutation passes the whole suite.
 *
 * They stay because the guard that makes them redundant is one refactor away
 * from being removed, and because `borrowedImage` is a helper someone may reuse
 * without the surrounding `isNotNull`. Do not read the comment as evidence the
 * tests cover it: nothing here can fail on their removal, and a claim that
 * something is protective is worth only as much as the test that shows it.
 */
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { events, venues } from "@/lib/db/schema";

/** Our own CDN. A relative path is ours too, and is matched separately. */
const OWNED_PREFIX = "https://cdn.meetmeatthefair.com/";

/**
 * `image_url` names a host that is not ours.
 *
 * Note this is FALSE for a null or empty image — "we have no image" and "we are
 * borrowing one" are different facts, and the venue sweep only wants the second.
 */
function borrowedImage(col: typeof events.imageUrl | typeof venues.imageUrl): SQL | undefined {
  return and(
    isNotNull(col),
    sql`TRIM(IFNULL(${col}, '')) != ''`,
    sql`IFNULL(${col}, '') NOT LIKE ${OWNED_PREFIX + "%"}`,
    sql`IFNULL(${col}, '') NOT LIKE '/%'`
  );
}

/**
 * Events the og:image sweep should consider.
 *
 * Before OPE-294 this was `image_url IS NULL OR ''` alone, so a hotlinked row
 * was permanently invisible to the one tool meant to clean it up — which is why
 * the event hotlink count climbed 28 (2026-07-28) → 51 (08-18) → 55 (08-31)
 * while the sweep ran happily against the rows that had no image at all.
 */
export function ogSweepCandidatePredicate(): SQL | undefined {
  return and(
    eq(events.status, "APPROVED"),
    or(isNull(events.imageUrl), eq(events.imageUrl, ""), borrowedImage(events.imageUrl)),
    isNotNull(events.sourceUrl),
    sql`TRIM(IFNULL(${events.sourceUrl}, '')) != ''`,
    isNull(events.ogImageSweepAttemptedAt)
  );
}

/** Venues whose image is served by somebody else. */
export function borrowedVenueImagePredicate(): SQL | undefined {
  return borrowedImage(venues.imageUrl);
}
