/**
 * OPE-294 — the sweep must be able to SEE a borrowed image.
 *
 * These run against a real SQLite rather than against a hand-reasoned
 * expectation of what the SQL means, because the defect being guarded is a
 * defect of SQL semantics rather than of intent: the old predicate matched
 * `image_url IS NULL OR ''` only, so a hotlinked row was permanently invisible
 * to the sweep. That is why the event hotlink count went 28 → 51 → 55 while the
 * sweep reported itself healthy. Reverting to that predicate turns three of
 * these red.
 *
 * The null-image cases below are NOT covering the `NULL NOT LIKE` trap, and it
 * would be easy to claim they are. Removing the IFNULL wrappers from
 * `borrowed.ts` leaves this suite fully green, because the `isNull` / `isNotNull`
 * guards already exclude NULL before a negated LIKE is reached. What those cases
 * genuinely pin is that widening the predicate for borrowed images did not cost
 * the sweep its ORIGINAL population — which is the regression a careless
 * widening would actually cause.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { events, venues } from "../../db/schema";
import { ogSweepCandidatePredicate, borrowedVenueImagePredicate } from "../borrowed";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT, slug TEXT, status TEXT,
    image_url TEXT, source_url TEXT, og_image_sweep_attempted_at INTEGER
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT, slug TEXT, image_url TEXT, website TEXT
  );
`;

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;

// Seeded with raw SQL rather than drizzle inserts: drizzle emits every column
// the real schema declares a default for, which would force this file to
// restate the entire events table just to test one WHERE clause. The SELECT —
// the thing actually under test — still goes through drizzle and the shared
// predicate.
function seedEvent(
  id: string,
  imageUrl: string | null,
  over: { status?: string; sourceUrl?: string | null; attemptedAt?: number | null } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO events (id, name, slug, status, image_url, source_url, og_image_sweep_attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      id,
      over.status ?? "APPROVED",
      imageUrl,
      over.sourceUrl === undefined ? "https://organizer.test/fair" : over.sourceUrl,
      over.attemptedAt ?? null
    );
}

function candidateIds() {
  return db
    .select({ id: events.id })
    .from(events)
    .where(ogSweepCandidatePredicate())
    .all()
    .map((r) => r.id)
    .sort();
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema });
});

describe("ogSweepCandidatePredicate", () => {
  it("selects a HOTLINKED event — the whole point of OPE-294", () => {
    seedEvent("hotlinked", "https://static.wixstatic.com/media/abc.jpg");
    // With the pre-OPE-294 predicate this row is absent, and the sweep that is
    // supposed to clean it up never sees it.
    expect(candidateIds()).toEqual(["hotlinked"]);
  });

  it("still selects a NULL-image event — the sweep's original population", () => {
    // The regression a careless widening causes: rewriting the image half in
    // terms of "not ours" alone would drop every imageless row, i.e. every row
    // the sweep was built for, while the hotlink test above stayed green.
    seedEvent("no-image", null);
    expect(candidateIds()).toEqual(["no-image"]);
  });

  it("still selects an EMPTY-STRING image event", () => {
    seedEvent("empty", "");
    expect(candidateIds()).toEqual(["empty"]);
  });

  it("does NOT select an image we already own on the CDN", () => {
    seedEvent("owned", "https://cdn.meetmeatthefair.com/events/x/og-1.jpg");
    expect(candidateIds()).toEqual([]);
  });

  it("does NOT select a relative path — same-origin is ours", () => {
    seedEvent("relative", "/images/fair.jpg");
    expect(candidateIds()).toEqual([]);
  });

  it("does not select a lookalike of our CDN under another domain", () => {
    // `cdn.meetmeatthefair.com.evil.test` must not read as ours. The prefix
    // match ends in a slash, which is what makes this hold.
    seedEvent("lookalike", "https://cdn.meetmeatthefair.com.evil.test/x.jpg");
    expect(candidateIds()).toEqual(["lookalike"]);
  });

  it("keeps the pre-existing guards: non-APPROVED, no source_url, already attempted", () => {
    seedEvent("draft", null, { status: "PENDING" });
    seedEvent("nosource", null, { sourceUrl: null });
    seedEvent("blanksource", null, { sourceUrl: "   " });
    seedEvent("attempted", null, { attemptedAt: 1_756_000_000 });
    // Widening the image half must not quietly widen the others.
    expect(candidateIds()).toEqual([]);
  });

  it("picks the borrowed and empty rows out of a mixed table", () => {
    seedEvent("a-hotlinked", "https://images.squarespace-cdn.com/x.jpg");
    seedEvent("b-null", null);
    seedEvent("c-owned", "https://cdn.meetmeatthefair.com/events/c/og.jpg");
    seedEvent("d-google", "https://lh3.googleusercontent.com/p/abc");
    expect(candidateIds()).toEqual(["a-hotlinked", "b-null", "d-google"]);
  });
});

describe("borrowedVenueImagePredicate", () => {
  function seedVenue(id: string, imageUrl: string | null) {
    sqlite
      .prepare(`INSERT INTO venues (id, name, slug, image_url, website) VALUES (?, ?, ?, ?, NULL)`)
      .run(id, id, id, imageUrl);
  }
  function borrowedIds() {
    return db
      .select({ id: venues.id })
      .from(venues)
      .where(borrowedVenueImagePredicate())
      .all()
      .map((r) => r.id)
      .sort();
  }

  it("selects the Google Places hotlinks and nothing we own", () => {
    seedVenue("google", "https://lh3.googleusercontent.com/p/AF1Q");
    seedVenue("wikipedia", "https://en.wikipedia.org/x.jpg");
    seedVenue("owned", "https://cdn.meetmeatthefair.com/venues/v/og.jpg");
    expect(borrowedIds()).toEqual(["google", "wikipedia"]);
  });

  it("does NOT select a venue with no image — null is not borrowed", () => {
    // The venue sweep must never treat an imageless venue as something to
    // clear. "We have no image" and "we are borrowing one" are different facts,
    // and only the second is this route's business.
    seedVenue("none", null);
    seedVenue("empty", "");
    expect(borrowedIds()).toEqual([]);
  });

  it("matches the lh4/lh5/lh6 Places subdomains, not only lh3", () => {
    // Google rotates across these; matching lh3 alone would look like a fix
    // while leaving photos behind.
    seedVenue("lh4", "https://lh4.googleusercontent.com/p/A");
    seedVenue("lh5", "https://lh5.googleusercontent.com/p/B");
    seedVenue("lh6", "https://lh6.googleusercontent.com/p/C");
    expect(borrowedIds()).toEqual(["lh4", "lh5", "lh6"]);
  });
});
