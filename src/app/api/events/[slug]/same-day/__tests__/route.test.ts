/**
 * Tests for GET /api/events/[slug]/same-day.
 *
 * Focus: route-shape contract (200 with expected JSON for happy path,
 * 404 for unknown slug, 200+empty when anchor has no dates, mapping of
 * joined rows to { ...event, venue, promoter }). SQL correctness (the
 * ABS-ordered overlap query) is verified manually post-deploy — see
 * the PR's test plan — because mocking Drizzle chains can't validate
 * SQL execution.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Use vi.hoisted so the mock factory below and the per-test beforeEach
// both reference the SAME shared state. Without this, callCount would
// live in the mock-factory's closure and leak across tests, mis-routing
// the second test's anchor query to the overlap mock.
const ctl = vi.hoisted(() => ({
  callCount: 0,
  anchorMock: (): unknown => [],
  overlapMock: (): unknown => [],
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn(() => null) }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({
    select: vi.fn(() => {
      ctl.callCount += 1;
      const isAnchor = ctl.callCount === 1;
      const chain = {
        from: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => (isAnchor ? ctl.anchorMock() : ctl.overlapMock())),
      };
      return chain;
    }),
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 60,
    limit: 60,
    resetAt: 0,
    isAuthenticated: false,
  })),
  rateLimitResponse: vi.fn(),
}));

import { GET } from "../route";

function makeRequest(slug: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/events/${encodeURIComponent(slug)}/same-day`);
}

function makeCtx(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctl.callCount = 0;
  ctl.anchorMock = () => [];
  ctl.overlapMock = () => [];
});

describe("GET /api/events/[slug]/same-day", () => {
  it("404 when the slug doesn't resolve to a publicly-visible event", async () => {
    ctl.anchorMock = () => Promise.resolve([]); // anchor query returns empty
    const res = await GET(makeRequest("unknown-event"), makeCtx("unknown-event"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("not_found");
  });

  it("returns success:true with empty events when anchor has no dates (TBD)", async () => {
    ctl.anchorMock = () => Promise.resolve([{ id: "anchor-id", startDate: null, endDate: null }]);
    const res = await GET(makeRequest("tbd-event"), makeCtx("tbd-event"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; events: unknown[] };
    expect(body.success).toBe(true);
    expect(body.events).toEqual([]);
    // Overlap query shouldn't even run when there's no anchor date.
    expect(ctl.callCount).toBe(1);
  });

  it("returns 200 with mapped { ...event, venue, promoter } rows on the happy path", async () => {
    ctl.anchorMock = () =>
      Promise.resolve([
        {
          id: "anchor-id",
          startDate: new Date("2026-09-26T12:00:00Z"),
          endDate: new Date("2026-09-26T23:00:00Z"),
        },
      ]);
    // Mock shape matches eventJoinProjection (singular `venue`/`promoter`
    // keys), which the route adopted in #360 to drop the join under D1's
    // 100-col cap. Pre-#360 shape used plural keys (raw bare-select result).
    ctl.overlapMock = () =>
      Promise.resolve([
        {
          events: { id: "other-1", name: "Overlapping Fair", slug: "overlapping-fair" },
          venue: { id: "v-1", name: "Town Hall" },
          promoter: null,
        },
        {
          events: { id: "other-2", name: "Same-Day Market", slug: "same-day-market" },
          venue: null,
          promoter: { id: "p-1", companyName: "Local Promoter" },
        },
      ]);

    const res = await GET(makeRequest("anchor"), makeCtx("anchor"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      events: { id: string; venue: unknown; promoter: unknown }[];
    };
    expect(body.success).toBe(true);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].id).toBe("other-1");
    expect(body.events[0].venue).toEqual({ id: "v-1", name: "Town Hall" });
    expect(body.events[0].promoter).toBeNull();
    expect(body.events[1].promoter).toEqual({ id: "p-1", companyName: "Local Promoter" });
  });

  it("returns empty array (200) when no events overlap", async () => {
    ctl.anchorMock = () =>
      Promise.resolve([
        {
          id: "anchor-id",
          startDate: new Date("2026-09-26T12:00:00Z"),
          endDate: new Date("2026-09-26T23:00:00Z"),
        },
      ]);
    ctl.overlapMock = () => Promise.resolve([]);

    const res = await GET(makeRequest("anchor"), makeCtx("anchor"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; events: unknown[] };
    expect(body.success).toBe(true);
    expect(body.events).toEqual([]);
  });
});
