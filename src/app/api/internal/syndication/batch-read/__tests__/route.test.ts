import { describe, it, expect, vi, beforeEach } from "vitest";
import { events, syndicationSubscriptions } from "@/lib/db/schema";

// Auth + logger mocked; the db mock returns fixtures keyed by the queried table
// so we can exercise both the internal path and the subscriber-scoped path.
vi.mock("@/lib/api-auth", () => ({ internalKeyMatches: vi.fn() }));
vi.mock("@/lib/syndication/auth", () => ({ resolveSyndicationSubscriber: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

let eventFixture: unknown[] = [];
let subscriptionFixture: unknown[] = [];
let lastFrom: unknown;

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn(function (this: unknown, t: unknown) {
    lastFrom = t;
    return this;
  }),
  leftJoin: vi.fn().mockReturnThis(),
  where: vi.fn(() =>
    Promise.resolve(lastFrom === syndicationSubscriptions ? subscriptionFixture : eventFixture)
  ),
};
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: vi.fn(() => mockDb) }));

import { POST } from "../route";
import { internalKeyMatches } from "@/lib/api-auth";
import { resolveSyndicationSubscriber } from "@/lib/syndication/auth";

const mockInternal = internalKeyMatches as unknown as ReturnType<typeof vi.fn>;
const mockSubscriber = resolveSyndicationSubscriber as unknown as ReturnType<typeof vi.fn>;

function req(body: unknown) {
  return new Request("http://localhost/api/internal/syndication/batch-read", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const E1 = {
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
};
const E2 = {
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
};

beforeEach(() => {
  vi.clearAllMocks();
  eventFixture = [];
  subscriptionFixture = [];
  lastFrom = undefined;
  mockInternal.mockResolvedValue(false);
  mockSubscriber.mockResolvedValue(null);
});

describe("POST /api/internal/syndication/batch-read — auth", () => {
  it("401s with neither an internal key nor a subscriber bearer token", async () => {
    const res = await POST(req({ eventIds: ["e1"] }));
    expect(res.status).toBe(401);
  });

  it("400s on an empty or oversized eventIds array (internal auth)", async () => {
    mockInternal.mockResolvedValue(true);
    expect((await POST(req({ eventIds: [] }))).status).toBe(400);
    expect((await POST(req({ eventIds: Array(201).fill("x") }))).status).toBe(400);
  });
});

describe("internal caller — full access", () => {
  it("returns mirrored fields + eventVersion, nesting the venue (null when none)", async () => {
    mockInternal.mockResolvedValue(true);
    eventFixture = [E1, E2];

    const res = await POST(req({ eventIds: ["e1", "e2"] }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
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
    // The subscriptions table is never queried for an internal caller.
    expect(mockDb.from).not.toHaveBeenCalledWith(syndicationSubscriptions);
  });
});

describe("subscriber bearer caller — scoped to subscriptions", () => {
  it("returns only events the subscriber is subscribed to", async () => {
    mockSubscriber.mockResolvedValue({ id: "sub-1" });
    // Subscriber tracks e1 only; e2 is filtered out even though requested.
    subscriptionFixture = [{ eventId: "e1" }];
    eventFixture = [E1];

    const res = await POST(req({ eventIds: ["e1", "e2"] }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.events.map((e: any) => e.eventId)).toEqual(["e1"]);
    // It scoped via the subscriptions table.
    expect(mockDb.from).toHaveBeenCalledWith(syndicationSubscriptions);
  });

  it("returns an empty list when the subscriber tracks none of the requested IDs", async () => {
    mockSubscriber.mockResolvedValue({ id: "sub-1" });
    subscriptionFixture = []; // no overlap
    eventFixture = [E1]; // would be returned if not scoped

    const res = await POST(req({ eventIds: ["e1"] }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.events).toEqual([]);
    // The events table is never read when the subscriber's scope is empty.
    expect(mockDb.from).not.toHaveBeenCalledWith(events);
  });
});
