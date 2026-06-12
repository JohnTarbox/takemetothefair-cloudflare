import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth + logger + db are mocked so the test exercises the route's shaping
// logic (mirrored projection → snapshot) without a real CF context.
vi.mock("@/lib/api-auth", () => ({ internalKeyMatches: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const whereMock = vi.fn();
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  where: whereMock,
};
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: vi.fn(() => mockDb) }));

import { POST } from "../route";
import { internalKeyMatches } from "@/lib/api-auth";

const mockAuth = internalKeyMatches as unknown as ReturnType<typeof vi.fn>;

function req(body: unknown) {
  return new Request("http://localhost/api/internal/syndication/batch-read", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/syndication/batch-read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s without a valid internal key", async () => {
    mockAuth.mockResolvedValue(false);
    const res = await POST(req({ eventIds: ["e1"] }));
    expect(res.status).toBe(401);
  });

  it("400s on an empty or oversized eventIds array", async () => {
    mockAuth.mockResolvedValue(true);
    expect((await POST(req({ eventIds: [] }))).status).toBe(400);
    expect((await POST(req({ eventIds: Array(201).fill("x") }))).status).toBe(400);
  });

  it("returns mirrored fields + eventVersion, nesting the venue", async () => {
    mockAuth.mockResolvedValue(true);
    whereMock.mockResolvedValue([
      {
        eventId: "e1",
        eventVersion: 3,
        name: "Gray Wild Blueberry Festival",
        slug: "gray-wild-blueberry-festival",
        startDate: new Date("2026-08-15T00:00:00.000Z"),
        endDate: new Date("2026-08-16T00:00:00.000Z"),
        venueName: "Town Common",
        venueAddress: "1 Main St",
        venueCity: "Gray",
        venueState: "ME",
        venueZip: "04039",
      },
      {
        eventId: "e2",
        eventVersion: 0,
        name: "Venueless Fair",
        slug: "venueless-fair",
        startDate: null,
        endDate: null,
        venueName: null,
        venueAddress: null,
        venueCity: null,
        venueState: null,
        venueZip: null,
      },
    ]);

    const res = await POST(req({ eventIds: ["e1", "e2"] }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.events).toEqual([
      {
        eventId: "e1",
        eventVersion: 3,
        name: "Gray Wild Blueberry Festival",
        slug: "gray-wild-blueberry-festival",
        startDate: "2026-08-15T00:00:00.000Z",
        endDate: "2026-08-16T00:00:00.000Z",
        venue: {
          name: "Town Common",
          address: "1 Main St",
          city: "Gray",
          state: "ME",
          zip: "04039",
        },
      },
      {
        eventId: "e2",
        eventVersion: 0,
        name: "Venueless Fair",
        slug: "venueless-fair",
        startDate: null,
        endDate: null,
        venue: null,
      },
    ]);
  });
});
