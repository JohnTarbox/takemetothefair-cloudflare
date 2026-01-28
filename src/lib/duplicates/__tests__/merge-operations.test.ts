/**
 * Tests for Duplicate Merge Operations
 */

import { describe, it, expect, vi } from "vitest";
import { getMergePreview, executeMerge } from "../merge-operations";

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

      await expect(
        getMergePreview(db as never, "unknown" as never, "id1", "id2")
      ).rejects.toThrow("Unknown entity type: unknown");
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

      await expect(
        executeMerge(db as never, "unknown" as never, "id1", "id2")
      ).rejects.toThrow("Unknown entity type: unknown");
    });
  });

  describe("venues merge", () => {
    it("transfers events and favorites to primary venue", async () => {
      const updateResults = { rowsAffected: 3 };
      const primaryVenue = { id: "primary-id", name: "Primary Venue" };

      let selectCallCount = 0;

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              // First select: existing favorites
              if (selectCallCount === 1) return Promise.resolve([{ userId: "user-1" }]);
              // Second select: merged entity
              if (selectCallCount === 2) return Promise.resolve([primaryVenue]);
              // Third select: event count
              return Promise.resolve([{ count: 5 }]);
            }),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              return Promise.resolve(updateResults);
            }),
          })),
        })),
        delete: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        })),
      } as unknown;

      const result = await executeMerge(db as never, "venues", "primary-id", "duplicate-id");

      expect(result.success).toBe(true);
      expect(result.deletedId).toBe("duplicate-id");
      expect(result.transferredRelationships).toBeDefined();
    });
  });

  describe("events merge", () => {
    it("merges events and combines view counts", async () => {
      const primaryEvent = { id: "primary-id", name: "Primary Event", viewCount: 100, venueId: "v1", promoterId: "p1" };
      const duplicateEvent = { id: "duplicate-id", viewCount: 50 };

      let selectCallCount = 0;

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) return Promise.resolve([{ vendorId: "vendor-1" }]); // primary vendors
              if (selectCallCount === 2) return Promise.resolve([duplicateEvent]); // duplicate event
              if (selectCallCount === 3) return Promise.resolve([{ userId: "user-1" }]); // existing favorites
              if (selectCallCount === 4) return Promise.resolve([primaryEvent]); // merged entity
              if (selectCallCount === 5) return Promise.resolve([{ name: "Venue" }]); // venue
              if (selectCallCount === 6) return Promise.resolve([{ companyName: "Promoter" }]); // promoter
              return Promise.resolve([{ count: 5 }]); // event vendor count
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

      const result = await executeMerge(db as never, "events", "primary-id", "duplicate-id");

      expect(result.success).toBe(true);
      expect(result.deletedId).toBe("duplicate-id");
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
              if (selectCallCount === 1) return Promise.resolve([{ eventId: "event-1" }, { eventId: "event-2" }]); // primary events
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

    let selectCallCount = 0;

    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            // First select: existing favorites - empty
            if (selectCallCount === 1) return Promise.resolve([]);
            // Second select: merged entity
            if (selectCallCount === 2) return Promise.resolve([primaryVenue]);
            // Third select: event count
            return Promise.resolve([{ count: 0 }]);
          }),
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
    } as unknown;

    const result = await executeMerge(db as never, "venues", "primary-id", "duplicate-id");

    expect(result.success).toBe(true);
    expect(result.transferredRelationships.favorites).toBe(0);
  });
});
