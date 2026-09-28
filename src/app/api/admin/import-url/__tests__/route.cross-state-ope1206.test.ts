/**
 * OPE-1206 — an import whose page says OREGON does not bind to a MAINE venue.
 *
 * The acceptance shape: JSON-LD `addressRegion: "OR"` (surfaced by the URL
 * extractor as `event.venueState`), and the wizard's chosen venue is the
 * Portland, Maine "Portland Expo". Drives the real route against the full test
 * schema (the MCP harness's createTestDb — one DDL, not a third copy); only the
 * side-effecting helpers are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../../../mcp-server/__tests__/setup-db";
import { events, promoters, venues } from "@/lib/db/schema";

let db: TestDb;

vi.mock("@/lib/api/with-auth", () => ({
  withAuth:
    (_opts: unknown, handler: (c: { request: NextRequest; db: unknown }) => unknown) =>
    (request: NextRequest) =>
      handler({ request, db }),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: () => ({}), getCloudflareDb: () => db }));
vi.mock("@/lib/audit/record-mutation", () => ({ recordMutation: vi.fn(async () => {}) }));
vi.mock("@/lib/series/resolve-or-create-series", () => ({
  attachEventToSeries: vi.fn(async () => {}),
}));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn(async () => {}) }));
vi.mock("@/lib/enrichment-log", () => ({ logEnrichment: vi.fn(async () => {}) }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => {}),
  indexNowUrlFor: () => "",
}));
vi.mock("@/lib/venues/geocode-one", () => ({ geocodeNewVenue: vi.fn(async () => {}) }));
vi.mock("@/lib/url-classification", () => ({
  loadClassifications: vi.fn(async () => new Map()),
  gateUrlForField: (u: string | null) => u,
}));
vi.mock("@/lib/duplicates/venue-date-collision", () => ({
  detectPossibleDuplicate: vi.fn(async () => null),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
// event_days rows are not what this measures; the harness DDL lacks their
// (event_id, date) unique index, which the real upsert's ON CONFLICT needs.
vi.mock("@/lib/events/insert-helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/events/insert-helpers")>()),
  insertEventDaysBatched: vi.fn(async () => {}),
}));

const { POST } = await import("../route");

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters)
    .values({ id: "p1", companyName: "Marketplace Events", slug: unsafeSlug("marketplace-events") })
    .run();
  db.insert(venues)
    .values({
      id: "v-me",
      name: "Portland Expo",
      slug: unsafeSlug("portland-expo"),
      address: "239 Park Ave",
      city: "Portland",
      state: "ME",
      zip: "04102",
    })
    .run();
});

async function importEvent(venueState: string) {
  const res = await POST(
    new NextRequest("http://localhost/api/admin/import-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          name: `Portland Holiday Market ${venueState}`,
          startDate: "2026-11-27",
          endDate: "2026-11-29",
          venueName: "Portland Expo Center",
          venueCity: "Portland",
          venueState,
        },
        venueOption: { type: "existing", id: "v-me" },
        promoterId: "p1",
        sourceUrl: "https://www.portlandholidaymarket.com/",
      }),
    }) as never,
    {} as never
  );
  const body = (await res.json()) as { success: boolean; event?: { id: string }; warning?: string };
  const row = body.event
    ? db.select().from(events).where(eq(events.id, body.event.id)).all()[0]
    : undefined;
  return { status: res.status, body, row };
}

describe("POST /api/admin/import-url — OPE-1206", () => {
  it("ACCEPTANCE: a page in OR does not bind to the Maine 'Portland Expo'", async () => {
    const r = await importEvent("OR");
    expect(r.body.success).toBe(true);
    expect(r.row?.venueId).toBeNull();
    expect(r.row?.status).toBe("PENDING");
    expect(r.row?.flaggedForReview).toBe(1);
    expect(r.body.warning).toContain("ME");
    expect(r.body.warning).toContain("OR");
  });

  it("the same venue with a page in ME is linked (control)", async () => {
    const r = await importEvent("ME");
    expect(r.row?.venueId).toBe("v-me");
    expect(r.body.warning).toBeUndefined();
  });
});
