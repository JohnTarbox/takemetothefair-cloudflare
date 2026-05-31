/**
 * Tests for findDuplicate — the shared dedup helper extracted from the
 * /api/suggest-event/check-duplicate route in K2 part 4 (2026-05-31).
 *
 * Unit coverage here focuses on:
 *   - Stage 1 (exact_url) — the short-circuit branch
 *   - The two early-return guards (no startDate, unparseable startDate)
 *
 * End-to-end stage 2/3 coverage lives in the mcp-server integration
 * tests (__tests__/email-handlers-submit.test.ts + inbound-emails-
 * dedup.test.ts) which exercise the /check-duplicate route against a
 * real better-sqlite3 in-memory database with seeded venues + events.
 * That's the right surface to assert venue_date / city_state_date /
 * similar_name_date branching because mocking Drizzle's chained
 * builders correctly requires reproducing more of the API surface than
 * the regression-protection value justifies for a refactor PR.
 *
 * Per [[feedback_drizzle_d1_unit_test_inject_db]] — the helper accepts
 * a `db: Database` param specifically to make it testable; the route
 * test that uses `getCloudflareDb()` covers the wire-up.
 */
import { describe, it, expect, vi } from "vitest";
import { findDuplicate } from "../find-duplicate";

vi.mock("@/lib/venue-matching", () => ({
  autoLinkVenue: vi.fn().mockResolvedValue({
    venueId: null,
    stateCode: null,
    decision: "no-name",
  }),
}));

describe("findDuplicate — stage 1 exact_url", () => {
  it("returns exact_url match when source_url equals an existing event", async () => {
    // Mock just enough Drizzle chain for the exact_url branch: one
    // .select().from().where().limit() that resolves to a single row.
    const exact = {
      id: "e1",
      slug: "winthrop-arts-festival-2026",
      name: "Winthrop Arts Festival 2026",
      startDate: new Date("2026-08-15"),
      status: "APPROVED",
      sourceUrl: "https://winthroparts.org",
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([exact])),
          })),
        })),
      })),
    } as unknown;

    const result = await findDuplicate(db as never, {
      sourceUrl: "https://winthroparts.org",
      name: "38th Annual Winthrop Arts Festival",
      startDate: "2026-08-15",
    });
    expect(result.isDuplicate).toBe(true);
    if (result.isDuplicate) {
      expect(result.matchType).toBe("exact_url");
      expect(result.existingEvent.id).toBe("e1");
    }
  });

  it("falls through when source_url doesn't match anything", async () => {
    // Stage 1 returns []; stage 2+ have no place signal AND no name →
    // returns isDuplicate=false. This exercises the exact_url branch
    // without engaging the harder-to-mock downstream stages.
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([])),
          })),
        })),
      })),
    } as unknown;

    const result = await findDuplicate(db as never, {
      sourceUrl: "https://newfair.org",
      // No startDate → stage 2+ skip via the guard below.
    });
    expect(result.isDuplicate).toBe(false);
  });
});

describe("findDuplicate — early-return guards", () => {
  it("returns isDuplicate=false when no startDate is given (no sourceUrl either)", async () => {
    const db = {} as unknown;
    const result = await findDuplicate(db as never, { name: "Some Event" });
    expect(result.isDuplicate).toBe(false);
  });

  it("returns isDuplicate=false when startDate isn't parseable", async () => {
    const db = {} as unknown;
    const result = await findDuplicate(db as never, {
      name: "Some Event",
      startDate: "not-a-date",
    });
    expect(result.isDuplicate).toBe(false);
  });
});
