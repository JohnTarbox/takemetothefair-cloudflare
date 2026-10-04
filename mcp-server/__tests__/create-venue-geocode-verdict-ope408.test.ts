/**
 * OPE-408 (2026-10-04) — a venue created without a pin says so.
 *
 * Specimen, prod 10-01: `create_venue` made "Hilton Garden Inn Freeport
 * Downtown" (`dd7c30cb`, 5 Park St, Freeport ME 04032). The confidence gate
 * refused it — `low-confidence`, "2 candidates", with the CORRECT address as the
 * candidate — and `geocodeNewVenueViaMainApp` discarded that answer. The tool
 * replied `created: true` and nothing else; an event was created there 20s
 * later; seven on-site photos matched nothing the next day.
 *
 * Pinned here, end to end through the real tool against a fake gate binding:
 * the verdict is in the response, a refusal leaves `venue.geocode.refused`, and
 * a pinned venue leaves neither a warning nor a row (both sides).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { adminActions, users } from "../src/schema.js";
import { geocodeNewVenueViaMainApp, verdictFromGateBody } from "../src/venues/geocode-new.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

/** The gate's real answer for `dd7c30cb`, as `venues_geocode` returned it 10-01. */
const REFUSED_BODY = {
  force: false,
  examined: 1,
  summary: { "low-confidence": 1 },
  next_cursor: null,
  results: [
    {
      venue_id: "v",
      name: "Hilton Garden Inn Freeport Downtown",
      before: { lat: null, lng: null },
      after: { lat: null, lng: null, place_id: null },
      status: "low-confidence",
      error: "2 candidates",
      candidate: "5 Park St, Freeport, ME 04032, USA",
    },
  ],
};
const PINNED_BODY = {
  force: false,
  examined: 1,
  summary: { ok: 1 },
  next_cursor: null,
  results: [
    {
      venue_id: "v",
      name: "Maine Coast Mall",
      before: { lat: null, lng: null },
      after: { lat: 44.5431, lng: -68.4198, place_id: "pid" },
      status: "ok",
      candidate: "225 High St, Ellsworth, ME 04605, USA",
    },
  ],
};

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;
let gateCalls: number;

function register(gateBody: unknown) {
  gateCalls = 0;
  const env = {
    MAIN_APP_URL: "https://meetmeatthefair.com",
    INTERNAL_API_KEY: "test-key",
    MAIN_APP: {
      fetch: (async () => {
        gateCalls++;
        return new Response(JSON.stringify(gateBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    },
  };
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, env as never);
}

beforeEach(() => {
  ({ db } = createTestDb());
  mock = mockIndexNowFetch();
});
afterEach(() => mock.restore());

interface CreateVenueBody {
  created: boolean;
  venue_id: string;
  geocode: Record<string, unknown>;
  warning?: string;
}

async function createVenue(extra: Record<string, unknown> = {}) {
  const r = (await server.invoke("create_venue", {
    name: "Hilton Garden Inn Freeport Downtown",
    address: "5 Park St",
    city: "Freeport",
    state: "ME",
    zip: "04032",
    ...extra,
  })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) as CreateVenueBody };
}

function refusedRows() {
  return db
    .select()
    .from(adminActions)
    .where(eq(adminActions.action, "venue.geocode.refused"))
    .all();
}

describe("OPE-408 — create_venue returns the geocode verdict", () => {
  it("SPECIMEN: a refused venue is created, and the response says it is unpinned and why", async () => {
    register(REFUSED_BODY);
    const { isError, body } = await createVenue();
    expect(isError).toBe(false);
    expect(body.created).toBe(true);
    expect(gateCalls).toBe(1);
    expect(body.geocode).toEqual({
      pinned: false,
      status: "low-confidence",
      reason: "2 candidates",
      candidate: "5 Park St, Freeport, ME 04032, USA",
    });
    expect(body.warning).toContain("WITHOUT a map pin");
    expect(body.warning).toContain("5 Park St, Freeport, ME 04032, USA");
    expect(body.warning).toContain("force: true");
  });

  it("SPECIMEN: the refusal is recorded once, with the gate's reason and candidate", async () => {
    register(REFUSED_BODY);
    const { body } = await createVenue();
    const rows = refusedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe(body.venue_id);
    expect(rows[0].actorUserId).toBe("u-admin");
    expect(JSON.parse(rows[0].payloadJson ?? "{}")).toEqual({
      status: "low-confidence",
      reason: "2 candidates",
      candidate: "5 Park St, Freeport, ME 04032, USA",
      source: "mcp:create_venue",
    });
  });

  it("control: a pinned venue carries the verdict, no warning, and no refusal row", async () => {
    register(PINNED_BODY);
    const { body } = await createVenue();
    expect(body.geocode).toMatchObject({ pinned: true, status: "ok", reason: null });
    expect(body.warning).toBeUndefined();
    expect(refusedRows()).toHaveLength(0);
  });

  it("a caller-supplied pin skips the gate and reports itself as pinned", async () => {
    register(REFUSED_BODY);
    const { body } = await createVenue({ latitude: 43.857, longitude: -70.1 });
    expect(gateCalls).toBe(0);
    expect(body.geocode).toMatchObject({ pinned: true, status: "caller-supplied" });
    expect(refusedRows()).toHaveLength(0);
  });
});

describe("OPE-408 — the verdict helper never throws, and says 'unavailable' when it cannot ask", () => {
  it("unconfigured, HTTP error, network throw and an empty body all read as unavailable", async () => {
    expect((await geocodeNewVenueViaMainApp({}, "v")).status).toBe("unavailable");
    const env = (impl: () => Promise<Response>) => ({
      MAIN_APP_URL: "https://x",
      INTERNAL_API_KEY: "k",
      MAIN_APP: { fetch: impl as unknown as typeof fetch },
    });
    const http500 = await geocodeNewVenueViaMainApp(
      env(async () => new Response("boom", { status: 500 })),
      "v"
    );
    expect(http500).toMatchObject({
      pinned: false,
      status: "unavailable",
      reason: "geocode gate HTTP 500",
    });
    const thrown = await geocodeNewVenueViaMainApp(
      env(async () => {
        throw new Error("network down");
      }),
      "v"
    );
    expect(thrown).toMatchObject({ pinned: false, status: "unavailable", reason: "network down" });
    expect(verdictFromGateBody({ results: [] }).status).toBe("unavailable");
  });

  it("duplicate-with names the venue that owns the place, as a merge candidate", () => {
    const v = verdictFromGateBody({
      results: [
        {
          status: "duplicate-with",
          after: { lat: null, lng: null },
          duplicate: { venue_id: "bb7c4ae0", name: "The Buker Center" },
        },
      ],
    });
    expect(v.pinned).toBe(false);
    expect(v.reason).toContain("The Buker Center");
    expect(v.reason).toContain("merge_venue");
  });
});

describe("OPE-408 — suggest_event, the second venue-creating caller, gets the same treatment", () => {
  it("a venue suggest_event creates without a pin is warned about and recorded", async () => {
    // `env` undefined → the gate cannot be asked → `unavailable`, not pinned.
    // The point is the WIRING on this path: the fix must not live in one of
    // the two callers only.
    db.insert(users).values({ id: "u-submitter", email: "s@test", role: "USER" }).run();
    const vendorServer = new CapturingMcpServer();
    registerVendorTools(
      vendorServer as never,
      db,
      { userId: "u-submitter", role: "USER" },
      undefined
    );
    const r = (await vendorServer.invoke("suggest_event", {
      name: "Freeport Holiday Expo",
      start_date: "2027-11-20",
      end_date: "2027-11-20",
      description: "A holiday expo.",
      venue_name: "Hilton Garden Inn Freeport Downtown",
      venue_city: "Freeport",
      venue_state: "ME",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.venue.matched).toBe(false);
    expect(body.venue.geocode).toMatchObject({ pinned: false, status: "unavailable" });
    expect(body.warnings?.venue_unpinned).toContain("no map pin");
    const rows = refusedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe(body.venue.venueId);
    expect(JSON.parse(rows[0].payloadJson ?? "{}").source).toBe("mcp:suggest_event");
  });
});
