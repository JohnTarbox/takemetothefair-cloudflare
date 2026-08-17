/**
 * OPE-437 — dedup MUST be able to see non-public events.
 *
 * The investigation: four Martha's Vineyard Fair editions exist at one venue,
 * but `search_events` returned only two. The 2028 and 2029 rows were invisible
 * by every path including a bare `venue_id` lookup, which suggested a hard date
 * ceiling somewhere.
 *
 * There is no date ceiling. `publicEventWhere()` gates on `status` AND
 * `lifecycle_status` and carries no date predicate at all. Those two rows are
 * `status = 'PENDING'`, and `PUBLIC_EVENT_STATUSES` is `[APPROVED, TENTATIVE]`
 * — so they fail the editorial gate. Their `lifecycle_status = 'TENTATIVE'`
 * actually passes the lifecycle gate. The `start_too_far_future` flag only
 * correlates because the ingest gate holds such events at PENDING rather than
 * auto-approving them; it is a marker, not the filter.
 *
 * That behaviour is correct: a PUBLIC search tool must not surface PENDING
 * rows.
 *
 * ---------------------------------------------------------------------------
 * What this test actually protects
 * ---------------------------------------------------------------------------
 *
 * The ticket's real question was whether the DEDUP path shares that filter. It
 * does not — `findDuplicate` never calls `publicEventWhere()` and has no status
 * predicate, which is why re-ingesting the organizer's page matches the PENDING
 * 2028 row instead of creating a duplicate of it. Verified against production:
 * stage 2's exact predicate (same venue, ±7 days of 2028-08-10) returns that
 * row.
 *
 * But nothing *enforced* that. `findDuplicate` selects `events.status` purely
 * to report it, and the surrounding codebase applies `publicEventWhere()` to
 * almost every other read. A later tidy-up that "makes dedup consistent with
 * the other queries" would silently blind it to every PENDING row — turning it
 * into exactly the duplicate factory the ticket feared, with no test failing.
 *
 * So this asserts the ABSENCE of that gate. It is a source-level check for the
 * same reason `vendor-link-visibility.test.ts` is: the property is "this
 * predicate is not applied anywhere in the file", which no amount of mocked
 * query-builder plumbing can express.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(__dirname, "..", "find-duplicate.ts"), "utf8");

describe("findDuplicate must not adopt the public-visibility gate", () => {
  it("does not call publicEventWhere()", () => {
    // Dedup answers "does a row like this already exist?", not "may the public
    // see it?". Applying the public gate here means an unreviewed PENDING row
    // is invisible to intake, and the next ingest of the same source creates a
    // second copy of it.
    expect(SOURCE).not.toContain("publicEventWhere");
  });

  it("does not filter on events.status", () => {
    // `status: events.status` in a select list is fine — that is reporting.
    // A status PREDICATE is not. Catch the common shapes.
    const predicates = [
      "eq(events.status",
      "inArray(events.status",
      "ne(events.status",
      "PUBLIC_EVENT_STATUSES",
    ];
    const found = predicates.filter((p) => SOURCE.includes(p));
    expect(found).toEqual([]);
  });

  it("still selects status so callers can SEE the match is unpublished", () => {
    // The opposite failure: dropping status from the projection would leave a
    // caller unable to tell a PENDING match from a live one, which is the
    // information that makes the match actionable.
    expect(SOURCE).toContain("status: events.status");
  });
});
