/**
 * OPE-665 — one collision strategy for venue slugs, not four.
 *
 * The same entity got a different URL shape depending on which code path
 * created it:
 *
 *   numeric suffix   src/lib/venue-minting.ts           "-2", "-3", …
 *   city suffix      admin/import/route.ts + this file  "-rangeley"
 *   state suffix     admin/import/route.ts              "-me"
 *   random uuid8     both, as a fallback                "-a3f9c210"
 *
 * The random fallback is the one that actually had to go. It is not
 * deterministic — the same suggestion retried produced a DIFFERENT public URL —
 * and it existed only because city/state can be absent. A numeric suffix can
 * always be formed, so nothing needs to fall back to randomness.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { venues, users } from "../src/schema.js";
import { slugCandidates, SLUG_CANDIDATE_ATTEMPTS, unsafeSlug } from "@takemetothefair/utils";

const AUTH = { userId: "u-submitter", role: "USER" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-submitter", email: "submitter@test", role: "USER" }).run();
  registerVendorTools(server as never, db, AUTH, undefined);
});

async function suggest(args: Record<string, unknown>) {
  const r = (await server.invoke("suggest_event", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!r.isError, payload: JSON.parse(r.content[0].text) };
}

function seedVenue(id: string, name: string, slug: string, city: string, state = "ME") {
  db.insert(venues)
    .values({
      id,
      name,
      slug: unsafeSlug(slug),
      address: "1 Main St",
      zip: "04101",
      city,
      state,
      status: "ACTIVE",
    } as never)
    .run();
}

const BASE_EVENT = {
  name: "Test Fair 2027",
  start_date: "2027-07-04",
  end_date: "2027-07-05",
  description: "A fair for testing venue slug collisions.",
};

describe("slugCandidates — the shared sequence (OPE-665)", () => {
  it("yields the plain slug FIRST, then numeric suffixes", () => {
    const got = [...slugCandidates(unsafeSlug("town-hall"), 4)];
    expect(got).toEqual(["town-hall", "town-hall-2", "town-hall-3", "town-hall-4"]);
  });

  it("is deterministic — the property the random fallback lacked", () => {
    // The whole reason the uuid8 fallback had to go: the same input must
    // always produce the same public URL.
    expect([...slugCandidates(unsafeSlug("town-hall"), 5)]).toEqual([
      ...slugCandidates(unsafeSlug("town-hall"), 5),
    ]);
  });

  it("never yields a city, a state or anything opaque", () => {
    // The suffix carries no meaning by design, so nothing can come to depend
    // on parsing it back out.
    for (const c of slugCandidates(unsafeSlug("town-hall"), 10)) {
      expect(c).toMatch(/^town-hall(-\d+)?$/);
    }
  });

  it("is bounded — an unbounded loop against a UNIQUE column is a hang", () => {
    expect([...slugCandidates(unsafeSlug("x"))]).toHaveLength(SLUG_CANDIDATE_ATTEMPTS);
  });
});

describe("suggest_event venue creation (OPE-665)", () => {
  it("uses the plain slug when nothing collides", async () => {
    const { isError } = await suggest({
      ...BASE_EVENT,
      venue_name: "Cumberland Fairgrounds",
      venue_city: "Cumberland",
      venue_state: "ME",
    });
    expect(isError).toBe(false);
    const rows = db.select().from(venues).where(eq(venues.name, "Cumberland Fairgrounds")).all();
    expect(rows[0].slug).toBe("cumberland-fairgrounds");
  });

  it("REUSES a same-slug venue rather than minting a suffixed one (K44)", async () => {
    // This is why the collision branch in this path is unreachable, and the
    // reason is worth pinning rather than restating. `existingVenues` is
    // populated by `slug = venueSlug OR normalizedName = …`, and K44 made the
    // follow-up unconditional: any candidate at all means reuse. So reaching
    // the create branch PROVES no row holds that slug — the old
    // `slugCollides` check could never be true, and the city/uuid suffixes it
    // guarded have never executed here.
    // The city AND the state must both differ. A same-state fixture is
    // rescued by `stateMatch` even with K44's fallback removed, so it passes
    // either way and proves nothing — verified by mutation, not assumed.
    seedVenue("v-existing", "Town Hall", "town-hall", "Portland", "ME");
    const { isError } = await suggest({
      ...BASE_EVENT,
      venue_name: "Town Hall",
      venue_city: "Bangor",
      venue_state: "NH",
    });
    expect(isError).toBe(false);
    const all = db.select().from(venues).all();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("v-existing");
    expect(all[0].slug).toBe("town-hall");
  });

  it("reuses on a normalized-name match even when the stored slug differs", async () => {
    // The legacy-generator case the OR clause exists for: stored slug dropped
    // the "&", so canonical createSlug would not find it by slug. If this ever
    // regressed to slug-only matching, the create branch WOULD become
    // reachable and start minting suffixed duplicates.
    // Again: neither city nor state may agree, or the weaker matchers rescue
    // the fixture and the test stops discriminating.
    seedVenue(
      "v-earth",
      "Earth Expo & Convention Center",
      "earth-expo-convention-center",
      "Uncasville",
      "CT"
    );
    const { isError } = await suggest({
      ...BASE_EVENT,
      venue_name: "Earth Expo & Convention Center",
      venue_city: "Montville",
      venue_state: "RI",
    });
    expect(isError).toBe(false);
    const all = db.select().from(venues).all();
    expect(all).toHaveLength(1);
    expect(all[0].slug).toBe("earth-expo-convention-center");
  });
});
