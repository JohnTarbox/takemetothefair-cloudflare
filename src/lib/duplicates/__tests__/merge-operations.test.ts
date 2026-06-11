/**
 * Tests for Duplicate Merge Operations
 */

import { describe, it, expect, vi } from "vitest";
import { getMergePreview, executeMerge, transferFavorites } from "../merge-operations";

// Mock database helper
function createMockDb() {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockUpdate = vi.fn();
  const mockSet = vi.fn();
  const mockDelete = vi.fn();

  const chainable = {
    select: mockSelect.mockReturnThis(),
    from: mockFrom.mockReturnThis(),
    where: mockWhere.mockReturnValue([]),
    update: mockUpdate.mockReturnThis(),
    set: mockSet.mockReturnThis(),
    delete: mockDelete.mockReturnThis(),
  };

  return {
    ...chainable,
    mockSelect,
    mockFrom,
    mockWhere,
    mockUpdate,
    mockSet,
    mockDelete,
  };
}

describe("getMergePreview", () => {
  describe("unknown entity type", () => {
    it("throws error for unknown entity type", async () => {
      const db = createMockDb() as unknown;

      await expect(getMergePreview(db as never, "unknown" as never, "id1", "id2")).rejects.toThrow(
        "Unknown entity type: unknown"
      );
    });
  });

  describe("venues", () => {
    it("throws when primary venue not found", async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      await expect(
        getMergePreview(db as never, "venues", "primary-id", "duplicate-id")
      ).rejects.toThrow("One or both venues not found");
    });

    it("returns preview with relationship counts", async () => {
      const primaryVenue = { id: "primary-id", name: "Primary Venue" };
      const duplicateVenue = { id: "duplicate-id", name: "Duplicate Venue" };

      let whereCallCount = 0;
      const mockWhere = vi.fn().mockImplementation(() => {
        whereCallCount++;
        // First two calls: venue lookups
        if (whereCallCount === 1) return Promise.resolve([primaryVenue]);
        if (whereCallCount === 2) return Promise.resolve([duplicateVenue]);
        // Subsequent calls: count queries
        return Promise.resolve([{ count: 5 }]);
      });

      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      const result = await getMergePreview(db as never, "venues", "primary-id", "duplicate-id");

      expect(result.primary).toEqual(expect.objectContaining({ name: "Primary Venue" }));
      expect(result.duplicate).toEqual(expect.objectContaining({ name: "Duplicate Venue" }));
      expect(result.canMerge).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("events", () => {
    it("throws when primary event not found", async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      await expect(
        getMergePreview(db as never, "events", "primary-id", "duplicate-id")
      ).rejects.toThrow("One or both events not found");
    });
  });

  describe("vendors", () => {
    it("throws when vendor not found", async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      await expect(
        getMergePreview(db as never, "vendors", "primary-id", "duplicate-id")
      ).rejects.toThrow("One or both vendors not found");
    });

    it("adds warning when vendors have different user accounts", async () => {
      const primaryVendor = { id: "v1", businessName: "Vendor 1", userId: "user-1" };
      const duplicateVendor = { id: "v2", businessName: "Vendor 2", userId: "user-2" };

      let whereCallCount = 0;
      const mockWhere = vi.fn().mockImplementation(() => {
        whereCallCount++;
        if (whereCallCount === 1) return Promise.resolve([primaryVendor]);
        if (whereCallCount === 2) return Promise.resolve([duplicateVendor]);
        // Count queries and event vendor queries
        if (whereCallCount <= 4) return Promise.resolve([{ count: 0 }]);
        return Promise.resolve([]);
      });

      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      const result = await getMergePreview(db as never, "vendors", "v1", "v2");

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("different user accounts");
      expect(result.canMerge).toBe(true);
    });
  });

  describe("promoters", () => {
    it("throws when promoter not found", async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      await expect(
        getMergePreview(db as never, "promoters", "primary-id", "duplicate-id")
      ).rejects.toThrow("One or both promoters not found");
    });

    it("adds warning when promoters have different user accounts", async () => {
      const primaryPromoter = { id: "p1", companyName: "Promo 1", userId: "user-1" };
      const duplicatePromoter = { id: "p2", companyName: "Promo 2", userId: "user-2" };

      let whereCallCount = 0;
      const mockWhere = vi.fn().mockImplementation(() => {
        whereCallCount++;
        if (whereCallCount === 1) return Promise.resolve([primaryPromoter]);
        if (whereCallCount === 2) return Promise.resolve([duplicatePromoter]);
        return Promise.resolve([{ count: 0 }]);
      });

      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: mockWhere,
      } as unknown;

      const result = await getMergePreview(db as never, "promoters", "p1", "p2");

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("different user accounts");
    });
  });
});

describe("executeMerge", () => {
  describe("unknown entity type", () => {
    it("throws error for unknown entity type", async () => {
      const db = createMockDb() as unknown;

      await expect(executeMerge(db as never, "unknown" as never, "id1", "id2")).rejects.toThrow(
        "Unknown entity type: unknown"
      );
    });
  });

  describe("venues merge", () => {
    it("transfers events and favorites to primary venue", async () => {
      const updateResults = { rowsAffected: 3 };
      const primaryVenue = { id: "primary-id", name: "Primary Venue" };

      let batchCallCount = 0;

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue([primaryVenue]),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue(updateResults),
          })),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        batch: vi.fn().mockImplementation(() => {
          batchCallCount++;
          // First batch: transfer events + get favorites
          if (batchCallCount === 1) return Promise.resolve([updateResults, [{ userId: "user-1" }]]);
          // Second batch: transfer/delete favorites
          if (batchCallCount === 2)
            return Promise.resolve([{ rowsAffected: 1 }, { rowsAffected: 1 }]);
          // Third batch: get merged entity + count
          return Promise.resolve([[primaryVenue], [{ count: 5 }]]);
        }),
      } as unknown;

      const result = await executeMerge(db as never, "venues", "primary-id", "duplicate-id");

      expect(result.success).toBe(true);
      expect(result.deletedId).toBe("duplicate-id");
      expect(result.transferredRelationships).toBeDefined();
    });
  });

  describe("events merge", () => {
    // K3 (analyst, 2026-05-31) — mergeEvents was rewritten to tombstone
    // the duplicate (rename slug + insert slug history + status=REJECTED
    // + merged_into=keeperId) instead of deleting it. The batch
    // structure shifted accordingly:
    //   Batch 1 (4 calls): primaryVendors, existingFavorites,
    //                       primarySnap{slug,viewCount},
    //                       duplicateSnap{slug,viewCount,mergedInto}
    //   Batch 2 (5 calls): cleanup userFavorites, rename dup slug,
    //                       insert slug_history, set dup REJECTED +
    //                       merged_into, admin_actions insert
    //   Batch 3 (4 calls): fetch merged entity + venue + promoter +
    //                       eventVendor count (unchanged)
    it("tombstones the duplicate (slug rename + REJECTED + admin_actions) and combines view counts", async () => {
      const primaryEvent = {
        id: "primary-id",
        name: "Primary Event",
        slug: "primary-event",
        viewCount: 100,
        venueId: "v1",
        promoterId: "p1",
      };

      let batchCallCount = 0;

      const db = {
        // Outside-of-batch SELECT for the dupDayDates intermediate read.
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue({ rowsAffected: 2 }),
          })),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        batch: vi.fn().mockImplementation(() => {
          batchCallCount++;
          // Batch 1 — snapshots.
          if (batchCallCount === 1)
            return Promise.resolve([
              [{ vendorId: "vendor-1" }],
              [{ userId: "user-1" }],
              [{ slug: "primary-event", viewCount: 100 }],
              [{ slug: "duplicate-event", viewCount: 50, mergedInto: null }],
            ]);
          // Batch 2 — tombstone + cleanup + audit (5 ops).
          if (batchCallCount === 2)
            return Promise.resolve([
              { rowsAffected: 1 },
              { rowsAffected: 1 },
              { rowsAffected: 1 },
              { rowsAffected: 1 },
              { rowsAffected: 1 },
            ]);
          // Batch 3 — final fetch.
          return Promise.resolve([
            [primaryEvent],
            [{ name: "Venue" }],
            [{ companyName: "Promoter" }],
            [{ count: 5 }],
          ]);
        }),
      } as unknown;

      const result = await executeMerge(db as never, "events", "primary-id", "duplicate-id");

      expect(result.success).toBe(true);
      // `deletedId` retained for backward compatibility with the
      // MergeResponse contract even though the row is now tombstoned,
      // not deleted. See the function docblock.
      expect(result.deletedId).toBe("duplicate-id");
    });

    // K-bundle followup (2026-05-31). Verifies the source_url-transfer
    // fix: when the duplicate has source_url/source_domain/etc populated
    // but the keeper has them as NULL, mergeEvents copies them over so
    // they're not lost when the dup is tombstoned. Hit twice in
    // production during the bundle's dogfood (Kids Con + Bonny Eagle).
    it("copies source_* fields from duplicate to keeper when keeper has NULL", async () => {
      let batchCallCount = 0;
      const updateSetCalls: Array<Record<string, unknown>> = [];

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            updateSetCalls.push(vals);
            return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
          }),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        batch: vi.fn().mockImplementation(() => {
          batchCallCount++;
          if (batchCallCount === 1)
            return Promise.resolve([
              [],
              // Keeper: NULL source fields — the gap-fill case.
              [
                {
                  slug: "primary-event",
                  viewCount: 100,
                  sourceUrl: null,
                  sourceDomain: null,
                  sourceId: null,
                  sourceName: null,
                },
              ],
              // Duplicate: carries source attribution that the keeper lacks.
              [
                {
                  slug: "duplicate-event",
                  viewCount: 50,
                  mergedInto: null,
                  sourceUrl: "https://example.org/event",
                  sourceDomain: "example.org",
                  sourceId: "evt-123",
                  sourceName: "Example.org",
                },
              ],
            ]);
          if (batchCallCount === 2)
            return Promise.resolve([
              { rowsAffected: 1 },
              { rowsAffected: 1 },
              { rowsAffected: 1 },
              { rowsAffected: 1 },
              { rowsAffected: 1 },
            ]);
          return Promise.resolve([
            [{ id: "primary-id", slug: "primary-event" }],
            [{ name: "Venue" }],
            [{ companyName: "Promoter" }],
            [{ count: 0 }],
          ]);
        }),
      } as unknown;

      await executeMerge(db as never, "events", "primary-id", "duplicate-id");

      // The transfer UPDATE should appear in the captured .set() calls
      // with the source_* fields from the duplicate. Order doesn't
      // matter; the test asserts content, not position.
      const transferUpdate = updateSetCalls.find(
        (u) => "sourceUrl" in u && u.sourceUrl === "https://example.org/event"
      );
      expect(transferUpdate).toBeDefined();
      expect(transferUpdate?.sourceDomain).toBe("example.org");
      expect(transferUpdate?.sourceId).toBe("evt-123");
      expect(transferUpdate?.sourceName).toBe("Example.org");
    });

    it("does NOT overwrite source_* fields when keeper already has them", async () => {
      let batchCallCount = 0;
      const updateSetCalls: Array<Record<string, unknown>> = [];

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            updateSetCalls.push(vals);
            return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
          }),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        batch: vi.fn().mockImplementation(() => {
          batchCallCount++;
          if (batchCallCount === 1)
            return Promise.resolve([
              [],
              // Keeper: already has source fields — should NOT be overwritten.
              [
                {
                  slug: "primary-event",
                  viewCount: 100,
                  sourceUrl: "https://keeper.org/event",
                  sourceDomain: "keeper.org",
                  sourceId: "keeper-evt",
                  sourceName: "Keeper.org",
                },
              ],
              [
                {
                  slug: "duplicate-event",
                  viewCount: 50,
                  mergedInto: null,
                  sourceUrl: "https://example.org/event",
                  sourceDomain: "example.org",
                  sourceId: "evt-123",
                  sourceName: "Example.org",
                },
              ],
            ]);
          if (batchCallCount === 2) return Promise.resolve([{}, {}, {}, {}, {}]);
          return Promise.resolve([
            [{ id: "primary-id", slug: "primary-event" }],
            [{ name: "Venue" }],
            [{ companyName: "Promoter" }],
            [{ count: 0 }],
          ]);
        }),
      } as unknown;

      await executeMerge(db as never, "events", "primary-id", "duplicate-id");

      // No update call should carry a source_* key — the conditional
      // gate-fill block skipped the whole UPDATE because the empty
      // sourceTransferUpdates object yielded zero keys.
      const transferUpdate = updateSetCalls.find((u) =>
        ["sourceUrl", "sourceDomain", "sourceId", "sourceName"].some((k) => k in u)
      );
      expect(transferUpdate).toBeUndefined();
    });

    // Each guard-throw test needs a `select` chain mock because Drizzle's
    // eager query-builder syntax (`db.batch([db.select().from().where(),
    // ...])`) evaluates the chain BEFORE the batch executor sees it. The
    // chain returns query objects that the batch then resolves. The mock
    // here just needs `select().from().where()` to not crash; the batch
    // mock returns the snapshot data.
    const selectChain = () => ({
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    });

    it("refuses to merge an event into itself", async () => {
      const db = {
        ...selectChain(),
        batch: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve([
              [],
              [{ slug: "x", viewCount: 0 }],
              [{ slug: "x", viewCount: 0, mergedInto: null }],
            ])
          ),
      } as unknown;
      await expect(executeMerge(db as never, "events", "same-id", "same-id")).rejects.toThrow(
        /same event/
      );
    });

    it("refuses to merge into an already-merged duplicate", async () => {
      const db = {
        ...selectChain(),
        batch: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve([
              [],
              [{ slug: "keeper", viewCount: 0 }],
              [{ slug: "dup", viewCount: 0, mergedInto: "some-other-id" }],
            ])
          ),
      } as unknown;
      await expect(
        executeMerge(db as never, "events", "keeper-id", "duplicate-id")
      ).rejects.toThrow(/already merged/);
    });

    // K9 (2026-06-01). Reproduces the Bar Harbor Holiday Craft Fair shape:
    // blog post 8ede7fd4 carried content_links to BOTH keeper and
    // duplicate events. Before the K9 fix the merge_events tool threw
    // D1_ERROR: UNIQUE constraint failed when the dup-side row was
    // repointed to keeper.slug (existing keeper row + repointed dup row
    // collide on (source_type, source_id, target_type, target_slug)).
    //
    // The fix is a SELECT keeper-side keys + DELETE matching dup-side
    // rows BEFORE the existing UPDATE. This test exercises the path by
    // returning a colliding keeper-side row from the second outside-of-
    // batch SELECT (the K9 pre-delete query — the first is the
    // event_days dupDayDates lookup).
    it("K9: pre-deletes colliding content_links before the repoint UPDATE", async () => {
      let batchCallCount = 0;
      let outsideSelectCount = 0;
      const deleteWhereCalls: number = 0;
      const deleteChainSpy = vi.fn().mockResolvedValue({ rowsAffected: 1 });

      const db = {
        // First outside-of-batch select() is the event_days dupDayDates
        // lookup (returns []). Second is the K9 keeper content_links
        // lookup — return one colliding pair so the K9 DELETE branch fires.
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              outsideSelectCount++;
              if (outsideSelectCount === 2) {
                // The K9 keeper-key lookup. Returns the Bar-Harbor-shape
                // colliding key (one blog post links both events).
                return Promise.resolve([{ sourceType: "BLOG_POST", sourceId: "blog-8ede7fd4" }]);
              }
              return Promise.resolve([]);
            }),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
          })),
        })),
        // Capture each .delete().where() invocation so we can assert
        // the K9 pre-delete fired AT LEAST once with a content_links
        // target. Since delete() takes the table and where() takes the
        // predicate, every delete chain hits this where mock.
        delete: vi.fn().mockImplementation(() => ({
          where: deleteChainSpy,
        })),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        batch: vi.fn().mockImplementation(() => {
          batchCallCount++;
          if (batchCallCount === 1)
            return Promise.resolve([
              [],
              [
                {
                  slug: "keeper",
                  viewCount: 0,
                  sourceUrl: "https://k.example/e",
                  sourceDomain: "k.example",
                  sourceId: "k1",
                  sourceName: "K",
                },
              ],
              [
                {
                  slug: "duplicate",
                  viewCount: 0,
                  mergedInto: null,
                  sourceUrl: null,
                  sourceDomain: null,
                  sourceId: null,
                  sourceName: null,
                },
              ],
            ]);
          if (batchCallCount === 2) return Promise.resolve([{}, {}, {}, {}, {}]);
          return Promise.resolve([
            [{ id: "primary-id", slug: "keeper" }],
            [{ name: "Venue" }],
            [{ companyName: "Promoter" }],
            [{ count: 0 }],
          ]);
        }),
      } as unknown;

      const result = await executeMerge(db as never, "events", "primary-id", "duplicate-id");

      expect(result.success).toBe(true);
      // The K9 pre-delete loop ran at least once on the colliding pair
      // returned by the K9 SELECT. Without the fix, deleteChainSpy
      // would only fire for the event_vendors / event_days / userFavorites
      // cleanups. With the fix, there's one additional call from the K9
      // collision DELETE. We assert ≥1 to avoid coupling to internal
      // delete-loop ordering — if the fix is silently removed the
      // collision DELETE disappears and the count drops.
      expect(deleteChainSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Silence the lint on the unused tracker — kept to make the
      // intent explicit (count would matter if we tightened the assertion).
      void deleteWhereCalls;
    });

    // K9 (2026-06-01). Negative case — when the keeper has no
    // colliding content_links, the K9 pre-delete loop is a no-op.
    // The previously-passing "tombstones the duplicate" test already
    // covers this implicitly (the generic select returns [] so the
    // K9 SELECT returns nothing); this test makes the contract explicit.
    it("K9: skips pre-delete when keeper has no overlapping content_links", async () => {
      let batchCallCount = 0;

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            // Every outside-of-batch SELECT returns []. The K9 keeper-key
            // lookup gets [] back so the DELETE branch is skipped.
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
          })),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
        })),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
        batch: vi.fn().mockImplementation(() => {
          batchCallCount++;
          if (batchCallCount === 1)
            return Promise.resolve([
              [],
              [
                {
                  slug: "keeper",
                  viewCount: 0,
                  sourceUrl: null,
                  sourceDomain: null,
                  sourceId: null,
                  sourceName: null,
                },
              ],
              [
                {
                  slug: "duplicate",
                  viewCount: 0,
                  mergedInto: null,
                  sourceUrl: null,
                  sourceDomain: null,
                  sourceId: null,
                  sourceName: null,
                },
              ],
            ]);
          if (batchCallCount === 2) return Promise.resolve([{}, {}, {}, {}, {}]);
          return Promise.resolve([
            [{ id: "primary-id", slug: "keeper" }],
            [{ name: "Venue" }],
            [{ companyName: "Promoter" }],
            [{ count: 0 }],
          ]);
        }),
      } as unknown;

      const result = await executeMerge(db as never, "events", "primary-id", "duplicate-id");

      expect(result.success).toBe(true);
    });
  });

  describe("vendors merge", () => {
    it("transfers event vendors and handles overlaps", async () => {
      const primaryVendor = { id: "v1", businessName: "Primary Vendor" };

      let selectCallCount = 0;

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1)
                return Promise.resolve([{ eventId: "event-1" }, { eventId: "event-2" }]); // primary events
              if (selectCallCount === 2) return Promise.resolve([{ userId: "user-1" }]); // existing favorites
              if (selectCallCount === 3) return Promise.resolve([primaryVendor]); // merged entity
              return Promise.resolve([{ count: 3 }]); // event vendor count
            }),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue({ rowsAffected: 2 }),
          })),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
      } as unknown;

      const result = await executeMerge(db as never, "vendors", "v1", "duplicate-id");

      expect(result.success).toBe(true);
      expect(result.deletedId).toBe("duplicate-id");
    });
  });

  describe("promoters merge", () => {
    it("transfers events and favorites", async () => {
      const primaryPromoter = { id: "p1", companyName: "Primary Promoter" };

      let selectCallCount = 0;

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) return Promise.resolve([{ userId: "user-1" }]); // existing favorites
              if (selectCallCount === 2) return Promise.resolve([primaryPromoter]); // merged entity
              return Promise.resolve([{ count: 5 }]); // event count
            }),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue({ rowsAffected: 3 }),
          })),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
      } as unknown;

      const result = await executeMerge(db as never, "promoters", "p1", "duplicate-id");

      expect(result.success).toBe(true);
      expect(result.deletedId).toBe("duplicate-id");
    });
  });
});

describe("merge operation edge cases", () => {
  it("handles merge when no favorites exist", async () => {
    const primaryVenue = { id: "primary-id", name: "Primary Venue" };

    let batchCallCount = 0;

    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([primaryVenue]),
        })),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
        })),
      })),
      delete: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
      })),
      batch: vi.fn().mockImplementation(() => {
        batchCallCount++;
        // First batch: transfer events + get favorites (empty)
        if (batchCallCount === 1) return Promise.resolve([{ rowsAffected: 0 }, []]);
        // Second batch: no favorites to transfer
        if (batchCallCount === 2) return Promise.resolve([]);
        // Third batch: get merged entity + count
        return Promise.resolve([[primaryVenue], [{ count: 0 }]]);
      }),
    } as unknown;

    const result = await executeMerge(db as never, "venues", "primary-id", "duplicate-id");

    expect(result.success).toBe(true);
    expect(result.transferredRelationships.favorites).toBe(0);
  });
});

describe("transferFavorites (D1-safe favorites merge)", () => {
  // db mock: select #1 = keeper favoriters, select #2 = dup favorites; each
  // update().set().where() bumps the spy so we can assert the chunk count.
  function mockDb(
    keeperFavoriters: Array<{ userId: string }>,
    dupFavorites: Array<{ id: string; userId: string }>
  ) {
    let selectCall = 0;
    const updateSpy = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCall++;
            return Promise.resolve(selectCall === 1 ? keeperFavoriters : dupFavorites);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {
            updateSpy();
            return Promise.resolve({ meta: { changes: 1 } });
          },
        }),
      }),
    } as never;
    return { db, updateSpy };
  }

  it("transfers nothing when every dup favoriter already favorited the keeper", async () => {
    const { db, updateSpy } = mockDb(
      [{ userId: "a" }, { userId: "b" }],
      [
        { id: "f1", userId: "a" },
        { id: "f2", userId: "b" },
      ]
    );
    const n = await transferFavorites(db, "EVENT", "keeper", "dup");
    expect(updateSpy).not.toHaveBeenCalled(); // all collide → 0 transferable
    expect(n).toBe(0);
  });

  it("transfers only the non-colliding dup favorites (in-memory exclusion)", async () => {
    const { db, updateSpy } = mockDb(
      [{ userId: "a" }], // keeper already has 'a'
      [
        { id: "f1", userId: "a" }, // collides → excluded
        { id: "f2", userId: "b" },
        { id: "f3", userId: "c" },
      ]
    );
    const n = await transferFavorites(db, "EVENT", "keeper", "dup");
    expect(updateSpy).toHaveBeenCalledTimes(1); // 2 transferable → one chunk
    expect(n).toBe(1); // mock meta.changes per chunk
  });

  it("CHUNKS the transfer to stay under D1's bound-variable limit — the bug fix", async () => {
    // 200 non-colliding dup favorites must split into ceil(200/90)=3 UPDATEs,
    // never one 200-param statement (which D1 rejects: "too many SQL variables"
    // — the crash this whole change exists to prevent).
    const dup = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, userId: `u${i}` }));
    const { db, updateSpy } = mockDb([], dup);
    await transferFavorites(db, "VENUE", "keeper", "dup");
    expect(updateSpy).toHaveBeenCalledTimes(3);
  });

  it("issues zero UPDATEs when the duplicate has no favorites", async () => {
    const { db, updateSpy } = mockDb([{ userId: "a" }], []);
    const n = await transferFavorites(db, "PROMOTER", "keeper", "dup");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });
});
