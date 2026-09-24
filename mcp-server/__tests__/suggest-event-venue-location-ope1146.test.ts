/**
 * OPE-1146 — a same-name venue in another place is a different venue.
 *
 * Specimen: `suggest_event` linked "Veterans Memorial Park, Old Orchard Beach,
 * ME" to the Norwalk, CT row of the same name, because K44's "always reuse a
 * name match" fell back to `existingVenues[0]` whatever its state.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { venues, users, events } from "../src/schema.js";
import { unsafeSlug } from "@takemetothefair/utils";

const AUTH = { userId: "u-submitter", role: "USER" as const };
let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-submitter", email: "submitter@test", role: "USER" }).run();
  registerVendorTools(server as never, db, AUTH, undefined);
});

function seedVenue(id: string, city: string, state: string) {
  db.insert(venues)
    .values({
      id,
      name: "Veterans Memorial Park",
      slug: unsafeSlug(
        id === "v-norwalk" ? "veterans-memorial-park" : `veterans-memorial-park-${id}`
      ),
      address: "1 Main St",
      zip: "00000",
      city,
      state,
      status: "ACTIVE",
    } as never)
    .run();
}

async function suggestAt(city: string, state: string) {
  const r = (await server.invoke("suggest_event", {
    name: `OOB Concert ${city}`,
    start_date: "2027-07-04",
    end_date: "2027-07-04",
    description: "A concert in the park.",
    venue_name: "Veterans Memorial Park",
    venue_city: city,
    venue_state: state,
  })) as { content: Array<{ text: string }>; isError?: boolean };
  expect(r.isError).toBeFalsy();
  const [ev] = db
    .select()
    .from(events)
    .where(eq(events.name, `OOB Concert ${city}`))
    .all();
  return ev;
}

describe("OPE-1146 — suggest_event venue matching respects location", () => {
  it("ACCEPTANCE: Old Orchard Beach, ME does NOT link to the Norwalk, CT row — a new ME venue is created", async () => {
    seedVenue("v-norwalk", "Norwalk", "CT");
    const ev = await suggestAt("Old Orchard Beach", "ME");
    expect(ev.venueId).not.toBe("v-norwalk");
    const [v] = db.select().from(venues).where(eq(venues.id, ev.venueId!)).all();
    expect(v.state).toBe("ME");
    expect(v.city).toBe("Old Orchard Beach");
  });

  it("with an OOB row present, links to it rather than to Norwalk", async () => {
    seedVenue("v-norwalk", "Norwalk", "CT");
    seedVenue("v-oob", "Old Orchard Beach", "ME");
    expect((await suggestAt("Old Orchard Beach", "ME")).venueId).toBe("v-oob");
  });

  it("K44 still holds: a same-name row with a BLANK city in the same state is reused, not duplicated", async () => {
    seedVenue("v-blank", "", "ME");
    expect((await suggestAt("Old Orchard Beach", "ME")).venueId).toBe("v-blank");
  });

  it("same state, different city is a different park", async () => {
    seedVenue("v-bangor", "Bangor", "ME");
    expect((await suggestAt("Old Orchard Beach", "ME")).venueId).not.toBe("v-bangor");
  });
});
