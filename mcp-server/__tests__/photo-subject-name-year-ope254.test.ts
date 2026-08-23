/**
 * OPE-254 — a reply naming the fair must reach the fair, even though the stored
 * slug carries an edition year the human never types.
 *
 * The live specimen: 2026-08-21 18:54Z, John replied to a held-photo
 * notification with subject "Re: Phillips Old Home Days" and body "This photo
 * is from Phillips Old Home Days in Phillips, Maine". The event is stored as
 * `phillips-old-home-days-2026`. The matcher required the WHOLE slug inside the
 * slugified subject, so `instr("re-phillips-old-home-days",
 * "phillips-old-home-days-2026")` was 0 and the photo stayed stranded.
 *
 * Measured on prod 2026-08-23: 930 of 1,463 approved events (64%) carry a
 * `-YYYY` suffix, so this was not an edge case — it was most of the catalogue.
 * Stripping the year makes only 19 of 1,443 base names (1.3%) ambiguous across
 * editions, and those still hold and ask.
 *
 * This defect could not have been seen before last week: OPE-404's LIKE-pattern
 * bug meant this matcher had never once succeeded in production, so nothing
 * downstream of it had ever been exercised.
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./setup-db.js";
import {
  findEventBySubjectName,
  slugWithoutYear,
  explicitYearIn,
} from "../src/email-handlers/photo-intake.js";
import { events, promoters, venues } from "../src/schema.js";

function freshDb() {
  const { db } = createTestDb();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p-1" }).run();
  db.insert(venues)
    .values({
      id: "v-1",
      name: "Fairgrounds",
      slug: "fairgrounds",
      address: "1 Main",
      city: "Phillips",
      state: "ME",
      zip: "04966",
    })
    .run();
  return db;
}

function seedEvent(db: ReturnType<typeof freshDb>, name: string, slug: string) {
  db.insert(events)
    .values({ id: `e-${slug}`, name, slug, promoterId: "p-1", status: "APPROVED", venueId: "v-1" })
    .run();
}

describe("slugWithoutYear / explicitYearIn", () => {
  it("strips only a trailing four-digit edition year", () => {
    expect(slugWithoutYear("phillips-old-home-days-2026")).toBe("phillips-old-home-days");
    expect(slugWithoutYear("waterford-worlds-fair")).toBe("waterford-worlds-fair");
    // Not a year, and not trailing — both must survive untouched.
    expect(slugWithoutYear("route-66-fair")).toBe("route-66-fair");
    expect(slugWithoutYear("expo-1776")).toBe("expo-1776");
  });

  it("reads a year the subject names, anywhere in it", () => {
    expect(explicitYearIn("re-phillips-old-home-days-2025")).toBe("2025");
    expect(explicitYearIn("photos-from-2026-fryeburg-fair")).toBe("2026");
    expect(explicitYearIn("re-phillips-old-home-days")).toBeNull();
  });
});

describe("findEventBySubjectName — the year suffix must not block a name match", () => {
  it("resolves the live 08-21 specimen: 'Re: Phillips Old Home Days'", async () => {
    const db = freshDb();
    seedEvent(db, "Phillips Old Home Days 2026", "phillips-old-home-days-2026");

    const hit = await findEventBySubjectName(db, "Re: Phillips Old Home Days");
    expect(hit?.slug).toBe("phillips-old-home-days-2026");
  });

  it("still resolves when the subject DOES carry the matching year", async () => {
    const db = freshDb();
    seedEvent(db, "Phillips Old Home Days 2026", "phillips-old-home-days-2026");

    expect((await findEventBySubjectName(db, "Phillips Old Home Days 2026"))?.slug).toBe(
      "phillips-old-home-days-2026"
    );
  });

  it("refuses a subject naming a DIFFERENT year", async () => {
    // For a photo, the wrong edition is a wrong answer, not a near miss: it puts
    // the picture on another year's page.
    const db = freshDb();
    seedEvent(db, "Phillips Old Home Days 2026", "phillips-old-home-days-2026");

    expect(await findEventBySubjectName(db, "Phillips Old Home Days 2025")).toBeNull();
  });

  it("holds when two editions of the same fair share a base name", async () => {
    // The 1.3% case. Name alone cannot pick an edition, so ask rather than guess.
    const db = freshDb();
    seedEvent(db, "Phillips Old Home Days 2025", "phillips-old-home-days-2025");
    seedEvent(db, "Phillips Old Home Days 2026", "phillips-old-home-days-2026");

    expect(await findEventBySubjectName(db, "Re: Phillips Old Home Days")).toBeNull();
  });

  it("picks the edition when the ambiguous pair is disambiguated by an explicit year", async () => {
    const db = freshDb();
    seedEvent(db, "Phillips Old Home Days 2025", "phillips-old-home-days-2025");
    seedEvent(db, "Phillips Old Home Days 2026", "phillips-old-home-days-2026");

    expect((await findEventBySubjectName(db, "Phillips Old Home Days 2026"))?.slug).toBe(
      "phillips-old-home-days-2026"
    );
  });

  it("keeps the MORE SPECIFIC fair when one base name contains another", async () => {
    // The regression that comparing raw slugs would introduce: the year sits
    // BETWEEN the two names, so `fryeburg-fair-2026` is not a substring of
    // `fryeburg-fair-antique-show-2026` and both would survive as "maximal",
    // holding a subject we can read perfectly well.
    const db = freshDb();
    seedEvent(db, "Fryeburg Fair 2026", "fryeburg-fair-2026");
    seedEvent(db, "Fryeburg Fair Antique Show 2026", "fryeburg-fair-antique-show-2026");

    expect((await findEventBySubjectName(db, "Fryeburg Fair Antique Show"))?.slug).toBe(
      "fryeburg-fair-antique-show-2026"
    );
  });

  it("still holds on two genuinely independent fair names", async () => {
    const db = freshDb();
    seedEvent(db, "Fryeburg Fair 2026", "fryeburg-fair-2026");
    seedEvent(db, "Skowhegan State Fair 2026", "skowhegan-state-fair-2026");

    expect(await findEventBySubjectName(db, "Fryeburg Fair and Skowhegan State Fair")).toBeNull();
  });

  it("does not let a year suffix smuggle a too-short name past the guard", async () => {
    // `mv-fair-2026` is 12 chars and would clear MIN_NAME_SLUG_LEN on the full
    // slug; its base `mv-fair` is 7 and must not. A two-letter fair name is far
    // too broad to attribute photos on.
    const db = freshDb();
    seedEvent(db, "MV Fair 2026", "mv-fair-2026");

    expect(await findEventBySubjectName(db, "Photos from the MV Fair")).toBeNull();
  });

  it("returns null for a subject that names no fair", async () => {
    const db = freshDb();
    seedEvent(db, "Phillips Old Home Days 2026", "phillips-old-home-days-2026");

    expect(await findEventBySubjectName(db, "Re: your message")).toBeNull();
    expect(await findEventBySubjectName(db, null)).toBeNull();
  });
});
