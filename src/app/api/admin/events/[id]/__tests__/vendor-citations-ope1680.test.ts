/**
 * OPE-1680 — the admin event form stores a vendor fee or application deadline
 * only with a citation naming the admin edit as its source. Covers both the
 * create route (POST /api/admin/events) and the edit route (PATCH
 * /api/admin/events/[id]). Real routes, real SQLite (the MCP harness's
 * createTestDb, which carries the db.batch shim the PATCH needs).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../../../../mcp-server/__tests__/setup-db";
import { eventDataCitations, events, promoters, users } from "@/lib/db/schema";

let db: TestDb;

vi.mock("@/lib/api/with-auth", () => ({
  withAuth:
    (
      _opts: unknown,
      handler: (ctx: {
        request: Request;
        db: unknown;
        session: unknown;
        params: unknown;
      }) => Promise<Response>
    ) =>
    async (request: Request, ctx?: { params: Promise<unknown> }) =>
      handler({
        request,
        db,
        session: { user: { id: "admin-1", role: "ADMIN" } },
        params: ctx ? await ctx.params : {},
      }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: () => ({}), getCloudflareDb: () => db }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => undefined),
  indexNowUrlFor: () => "https://x.test/",
}));
vi.mock("@/lib/approval-notification", () => ({ notifyApprovalIfNeeded: vi.fn() }));
vi.mock("@/lib/queues/producers", () => ({ enqueueSyndicationChange: vi.fn() }));
vi.mock("@/lib/content-links-sync", () => ({ repairBlogLinksForSlugChange: vi.fn() }));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn(async () => {}) }));
vi.mock("@/lib/syndication/outbox", () => ({ eventSyndicationStatements: () => [] }));
vi.mock("@/lib/series/resolve-or-create-series", () => ({
  attachEventToSeries: vi.fn(async () => {}),
}));
vi.mock("@/lib/duplicates/venue-date-collision", () => ({
  detectPossibleDuplicate: vi.fn(async () => null),
}));
vi.mock("@/lib/events/insert-helpers", async (orig) => ({
  ...(await orig<typeof import("@/lib/events/insert-helpers")>()),
  insertEventDaysBatched: vi.fn(async () => {}),
}));

const { PATCH } = await import("../route");
const { POST } = await import("../../route");

const json = (body: Record<string, unknown>, method: string, path: string) =>
  new Request(`https://x.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function patch(body: Record<string, unknown>) {
  const res = await (
    PATCH as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>
  )(json(body, "PATCH", "/api/admin/events/e1"), { params: Promise.resolve({ id: "e1" }) });
  return res.status;
}

async function create(body: Record<string, unknown>) {
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(
    json(
      {
        name: "Autumn Craft Fair",
        promoterId: "p1",
        startDate: "2026-10-03T12:00:00.000Z",
        endDate: "2026-10-04T12:00:00.000Z",
        categories: [],
        tags: [],
        status: "DRAFT",
        stateCode: "ME",
        ...body,
      },
      "POST",
      "/api/admin/events"
    )
  );
  return { status: res.status, body: (await res.json()) as { id?: string; error?: unknown } };
}

const citesFor = (eventId: string, state?: "active" | "superseded") =>
  db
    .select()
    .from(eventDataCitations)
    .where(
      state
        ? and(eq(eventDataCitations.eventId, eventId), eq(eventDataCitations.state, state))
        : eq(eventDataCitations.eventId, eventId)
    )
    .all();

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(users)
    .values({ id: "admin-1", email: "admin@example.test", role: "ADMIN" } as never)
    .run();
  db.insert(promoters)
    .values({ id: "p1", companyName: "Fair Assoc", slug: unsafeSlug("fair-assoc") })
    .run();
  db.insert(events)
    .values({
      id: "e1",
      name: "Harvest Fair",
      slug: unsafeSlug("harvest-fair"),
      promoterId: "p1",
      status: "DRAFT",
      sourceUrl: "https://mainefairs.example/hf",
      vendorFeeMinCents: 4000,
    } as never)
    .run();
});

describe("OPE-1680 — admin create cites the vendor fields it stores", () => {
  it("one admin-ui citation per stored field, NOT the event's source_url", async () => {
    const r = await create({
      vendorFeeMin: 50,
      vendorFeeMax: 90,
      applicationDeadline: "2026-09-01T12:00:00.000Z",
      sourceUrl: "https://autumncraft.example/",
    });
    expect(r.status).toBe(201);
    const cites = citesFor(r.body.id!);
    expect(cites.map((c) => c.fieldName).sort()).toEqual([
      "application_deadline",
      "vendor_fee_max",
      "vendor_fee_min",
    ]);
    for (const c of cites) {
      expect(c).toMatchObject({
        sourceUrl: `submission://admin-ui/${r.body.id}`,
        sourceType: "other",
        state: "active",
        createdBy: "admin-1",
      });
    }
    expect(cites.find((c) => c.fieldName === "vendor_fee_min")!.value).toBe("50");
    expect(cites.find((c) => c.fieldName === "application_deadline")!.value).toBe("2026-09-01");
  });

  it("a create with no fee or deadline writes no citation (landmark: the event exists)", async () => {
    const r = await create({});
    expect(r.status).toBe(201);
    expect(db.select().from(events).where(eq(events.id, r.body.id!)).all()).toHaveLength(1);
    expect(citesFor(r.body.id!)).toHaveLength(0);
  });
});

describe("OPE-1680 — admin edit cites only what it changes", () => {
  it("a changed fee is cited and supersedes the prior active citation", async () => {
    expect(await patch({ vendorFeeMin: 45 })).toBe(200);
    expect(await patch({ vendorFeeMin: 55 })).toBe(200);
    const active = citesFor("e1", "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      fieldName: "vendor_fee_min",
      value: "55",
      sourceUrl: "submission://admin-ui/e1",
      createdBy: "admin-1",
    });
    expect(citesFor("e1", "superseded")).toHaveLength(1);
  });

  it("re-posting the stored fee writes nothing", async () => {
    expect(await patch({ vendorFeeMin: 40, name: "Harvest Fair" })).toBe(200);
    expect(citesFor("e1")).toHaveLength(0);
  });

  it("an edit that does not touch vendor fields writes nothing (landmark: the edit landed)", async () => {
    expect(await patch({ vendorFeeNotes: "Booths $40" })).toBe(200);
    expect(db.select().from(events).where(eq(events.id, "e1")).get()!.vendorFeeNotes).toBe(
      "Booths $40"
    );
    expect(citesFor("e1")).toHaveLength(0);
  });

  it("a new deadline is cited; clearing the fee cites nothing", async () => {
    expect(
      await patch({ applicationDeadline: "2026-08-15T12:00:00.000Z", vendorFeeMin: null })
    ).toBe(200);
    const cites = citesFor("e1");
    expect(cites.map((c) => c.fieldName)).toEqual(["application_deadline"]);
    expect(cites[0].value).toBe("2026-08-15");
  });
});
