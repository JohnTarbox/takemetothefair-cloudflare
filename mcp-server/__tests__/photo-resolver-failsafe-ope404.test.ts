/**
 * OPE-404 item 2 — an identification lookup that throws must HOLD the photo,
 * never kill the email.
 *
 * The LIKE-pattern defect (fixed in PR #863) did not merely fail to match: it
 * threw, the throw became `caughtError` in the workflow, and the row landed on
 * `status='failed'` with no recovery path. The specific bug is gone; this pins
 * the class behaviour so the next lookup that throws costs a reply rather than
 * a photo.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestDb } from "./setup-db.js";
import { resolvePhotoEvent, findEventBySubjectName } from "../src/email-handlers/photo-intake.js";
import { events, promoters, venues } from "../src/schema.js";

afterEach(() => vi.restoreAllMocks());

function freshDb() {
  const { db } = createTestDb();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p-1" }).run();
  db.insert(venues)
    .values({
      id: "v-1",
      name: "Fairgrounds",
      slug: "fairgrounds",
      address: "1 Main",
      city: "Waterford",
      state: "ME",
      zip: "04088",
    })
    .run();
  return db;
}

function seedEvent(db: ReturnType<typeof freshDb>, name: string, slug: string) {
  db.insert(events)
    .values({ id: `e-${slug}`, name, slug, promoterId: "p-1", status: "APPROVED", venueId: "v-1" })
    .run();
}

describe("resolvePhotoEvent — lookup failures hold, never throw", () => {
  it("holds when the subject-name lookup throws instead of propagating", async () => {
    const db = freshDb();
    seedEvent(db, "Waterford World's Fair 2026", "waterford-worlds-fair-2026");

    // Simulate the OPE-404 shape: the DB rejects the query outright.
    const boom = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
    });

    const out = await resolvePhotoEvent(
      db,
      [],
      async () => ({}),
      "Photos from the Waterford World's Fair 2026"
    );

    expect(boom).toHaveBeenCalled();
    // Held, not resolved — and critically, no throw escaped.
    expect(out.resolution.status).toBe("held");
  });

  it("still resolves normally when nothing throws", async () => {
    const db = freshDb();
    seedEvent(db, "Waterford World's Fair 2026", "waterford-worlds-fair-2026");

    const out = await resolvePhotoEvent(
      db,
      [],
      async () => ({}),
      "Photos from the Waterford World's Fair 2026"
    );

    expect(out.resolution.status).toBe("resolved");
  });

  it("holds an ambiguous subject rather than guessing — the Belgrade Lakes case", async () => {
    const db = freshDb();
    // Both real prod rows. Subject slugifies to `belgrade-lakes`; neither slug
    // fits inside it, so there is no match to make and holding is correct.
    seedEvent(db, "Belgrade Lakes Market 2026", "belgrade-lakes-market-2026");
    seedEvent(
      db,
      "Belgrade Village Green Artisan Fair Series 2026",
      "belgrade-village-green-artisan-fair-series-2026"
    );

    expect(await findEventBySubjectName(db, "Belgrade Lakes")).toBeNull();

    const out = await resolvePhotoEvent(db, [], async () => ({}), "Belgrade Lakes");
    expect(out.resolution.status).toBe("held");
  });

  it("holds when the EXIF read throws", async () => {
    const db = freshDb();
    const out = await resolvePhotoEvent(
      db,
      [],
      async () => {
        throw new Error("R2 unavailable");
      },
      "Belgrade Lakes"
    ).catch((e) => e);

    // Documents current behaviour precisely: readExif is hold-on-failure by
    // contract at its own boundary, so a throw here is the CALLER's contract
    // breach, not something resolvePhotoEvent should mask. If this ever starts
    // returning a resolution instead, that is a deliberate change, not a drift.
    expect(out).toBeInstanceOf(Error);
  });
});
