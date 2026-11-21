/**
 * OPE-1680 — a vendor fee or application deadline the URL import stores is
 * cited to the page it was extracted from. Real route, real SQLite (the MCP
 * harness's createTestDb); only side-effecting helpers are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../../../mcp-server/__tests__/setup-db";
import { eventDataCitations, events, promoters, users, venues } from "@/lib/db/schema";

let db: TestDb;

vi.mock("@/lib/api/with-auth", () => ({
  withAuth:
    (
      _opts: unknown,
      handler: (c: { request: NextRequest; db: unknown; session: unknown }) => unknown
    ) =>
    (request: NextRequest) =>
      handler({ request, db, session: { user: { id: "admin-1", role: "ADMIN" } } }),
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
vi.mock("@/lib/events/insert-helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/events/insert-helpers")>()),
  insertEventDaysBatched: vi.fn(async () => {}),
}));

const { POST } = await import("../route");

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(users)
    .values({ id: "admin-1", email: "admin@example.test", role: "ADMIN" } as never)
    .run();
  db.insert(promoters)
    .values({ id: "p1", companyName: "Harvest Assoc", slug: unsafeSlug("harvest-assoc") })
    .run();
  db.insert(venues)
    .values({
      id: "v1",
      name: "Fairgrounds",
      slug: unsafeSlug("fairgrounds"),
      address: "1 Fair Rd",
      city: "Fryeburg",
      state: "ME",
      zip: "04037",
    })
    .run();
});

const PAGE = "https://harvestfair.example/vendors";

async function importEvent(extra: Record<string, unknown>, sourceUrl: string | null = PAGE) {
  const res = await POST(
    new NextRequest("http://localhost/api/admin/import-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          name: "Harvest Fair",
          startDate: "2026-09-12",
          endDate: "2026-09-13",
          venueName: "Fairgrounds",
          venueCity: "Fryeburg",
          venueState: "ME",
          ...extra,
        },
        venueOption: { type: "existing", id: "v1" },
        promoterId: "p1",
        sourceUrl,
      }),
    }) as never,
    {} as never
  );
  const body = (await res.json()) as { success: boolean; event?: { id: string } };
  const id = body.event?.id;
  const cites = id
    ? db.select().from(eventDataCitations).where(eq(eventDataCitations.eventId, id)).all()
    : [];
  const row = id ? db.select().from(events).where(eq(events.id, id)).all()[0] : undefined;
  return { body, cites, row };
}

describe("POST /api/admin/import-url — OPE-1680 vendor citations", () => {
  it("cites each stored vendor field to the imported page", async () => {
    const r = await importEvent({
      vendorFeeMin: 40,
      vendorFeeMax: 75.5,
      applicationDeadline: "2026-08-01",
    });
    expect(r.body.success).toBe(true);
    expect(r.row?.vendorFeeMinCents).toBe(4000);
    const byField = Object.fromEntries(r.cites.map((c) => [c.fieldName, c]));
    expect(Object.keys(byField).sort()).toEqual([
      "application_deadline",
      "vendor_fee_max",
      "vendor_fee_min",
    ]);
    expect(byField.vendor_fee_min).toMatchObject({
      value: "40",
      sourceUrl: PAGE,
      sourceType: "other",
      state: "active",
      createdBy: "admin-1",
      year: null,
    });
    expect(byField.vendor_fee_max.value).toBe("75.5");
    expect(byField.application_deadline.value).toBe("2026-08-01");
  });

  it("an import that extracted no fee or deadline writes no citation (landmark: the event exists)", async () => {
    const r = await importEvent({});
    expect(r.row).toBeDefined();
    expect(r.cites).toHaveLength(0);
  });

  it("with no source URL the citation falls back to the admin-ui submission identity", async () => {
    const r = await importEvent({ vendorFeeMin: 25 }, null);
    expect(r.cites).toHaveLength(1);
    expect(r.cites[0].sourceUrl).toBe(`submission://admin-ui/${r.body.event!.id}`);
  });
});
