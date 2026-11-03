/**
 * OPE-1079 — `update_venue` / `create_venue` with a pin far from the other
 * venues in the same city+state: the write goes through (flag, never block),
 * the response carries `pin_warning`, and an admin_actions row records it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { unsafeSlug, VENUE_PIN_FAR_FROM_TOWN_ACTION } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, venues } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
// No MAIN_APP_URL: create_venue's geocode round-trip is out of scope here.
const ENV = {};

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

// Real prod Freeport, ME pins.
const FREEPORT = [
  [43.8577105, -70.1029706],
  [43.8559512, -70.1045088],
  [43.8571379, -70.0997861],
];

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  FREEPORT.forEach(([lat, lng], i) =>
    db
      .insert(venues)
      .values({
        id: `f${i}`,
        name: `Freeport ${i}`,
        slug: unsafeSlug(`freeport-${i}`),
        address: "Main St",
        city: "Freeport",
        state: "ME",
        zip: "04032",
        latitude: lat,
        longitude: lng,
      })
      .run()
  );
  db.insert(venues)
    .values({
      id: "target",
      name: "Target Venue",
      slug: unsafeSlug("target-venue"),
      address: "5 Park St",
      city: "Freeport",
      state: "ME",
      zip: "04032",
    })
    .run();
});
afterEach(() => mock.restore());

async function call(tool: string, args: Record<string, unknown>) {
  const r = (await server.invoke(tool, args)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) as Record<string, any> };
}

const flagsFor = (id: string) =>
  db
    .select()
    .from(adminActions)
    .where(
      and(eq(adminActions.action, VENUE_PIN_FAR_FROM_TOWN_ACTION), eq(adminActions.targetId, id))
    )
    .all();

describe("update_venue pin sanity (OPE-1079)", () => {
  it("writes a far pin, warns, and records admin_actions", async () => {
    const { isError, body } = await call("update_venue", {
      venue_id: "target",
      latitude: 43.8937598, // Brunswick Landing, ~15 km away
      longitude: -69.9270216,
    });
    expect(isError).toBe(false);
    expect(body.fieldsUpdated).toEqual(["latitude", "longitude"]);
    expect(body.pin_warning).toMatch(/km from the median of 3 other venues in Freeport, ME/);

    const [v] = db.select().from(venues).where(eq(venues.id, "target")).all();
    expect(v.latitude).toBeCloseTo(43.8937598, 6); // never blocked

    const rows = flagsFor("target");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payloadJson as string)).toMatchObject({
      source: "mcp:update_venue",
      peers: 3,
    });
    expect(rows[0].actorUserId).toBe("u-admin");
  });

  it("an in-town pin (the New Portland-style CORRECTION path) is silent", async () => {
    const { body } = await call("update_venue", {
      venue_id: "target",
      latitude: 43.8571,
      longitude: -70.0998,
    });
    expect(body.pin_warning).toBeUndefined();
    expect(flagsFor("target")).toHaveLength(0);
  });

  it("does not run when coordinates are not part of the update", async () => {
    // Give the target a far pin directly, then edit only the description.
    db.update(venues)
      .set({ latitude: 43.89, longitude: -69.92 })
      .where(eq(venues.id, "target"))
      .run();
    const { body } = await call("update_venue", { venue_id: "target", description: "x" });
    expect(body.pin_warning).toBeUndefined();
    expect(flagsFor("target")).toHaveLength(0);
  });
});

describe("create_venue pin sanity for a caller-supplied pin (OPE-1079)", () => {
  it("creates the venue with the far pin and warns", async () => {
    const { isError, body } = await call("create_venue", {
      name: "Far Freeport Venue",
      address: "1 Somewhere Rd",
      city: "Freeport",
      state: "ME",
      zip: "04032",
      latitude: 43.8937598,
      longitude: -69.9270216,
    });
    expect(isError).toBe(false);
    expect(body.created).toBe(true);
    expect(body.pin_warning).toMatch(/Freeport, ME/);
    expect(flagsFor(body.venue_id)).toHaveLength(1);
  });
});
