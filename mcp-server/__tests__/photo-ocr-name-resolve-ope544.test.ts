/**
 * OPE-544 — the fair's own name, read off the image, is an identifier.
 *
 * The specimen: 2026-08-24, John emailed the Hillsborough County Agricultural
 * Fair LOGO to submit@. The image says, in plain lettering,
 * "THE HILLSBOROUGH COUNTY AGRICULTURAL FAIR · NEW BOSTON, NH". OCR read 1584
 * characters of it. We replied "which fair?" — while `648adc1d`
 * (APPROVED, New Boston NH) sat in the events table.
 *
 * Resolution keyed on EXIF GPS (`"reason": "no-exif-gps"`, confirmed by a
 * `replay_inbound_attachment` dry run), which a logo — or any image an email
 * client stripped — will never carry. So it gave up before anything consulted
 * the text. The identifying value was extracted and then discarded, which is
 * OPE-541's shape one lane over.
 *
 * The fix reuses `findEventBySubjectName` unchanged. These tests exist because
 * that function was written for a SHORT SUBJECT LINE and is now handed ~1.5 KB
 * of OCR prose: what has to hold is that its guards, not its input size, are
 * what make it safe.
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./setup-db.js";
import { findEventBySubjectName } from "../src/email-handlers/photo-intake.js";
import { resolveOccurrence } from "../src/photo/resolve-occurrence.js";
import { events, promoters, venues } from "../src/schema.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function freshDb() {
  const { db } = createTestDb();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p-1" }).run();
  db.insert(venues)
    .values({
      id: "v-1",
      name: "Hillsborough County 4-H Fairgrounds",
      slug: "hillsborough-county-4h-fairgrounds",
      address: "15 Hilldale Ln",
      city: "New Boston",
      state: "NH",
      zip: "03070",
    })
    .run();
  return db;
}

function seedEvent(
  db: ReturnType<typeof freshDb>,
  name: string,
  slug: string,
  opts: { status?: string; mergedInto?: string } = {}
) {
  db.insert(events)
    .values({
      id: `e-${slug}`,
      name,
      slug,
      promoterId: "p-1",
      status: (opts.status ?? "APPROVED") as "APPROVED",
      venueId: "v-1",
      mergedInto: opts.mergedInto ?? null,
    })
    .run();
}

/**
 * Vision output is a DESCRIPTION with the lettering transcribed inside it, not
 * a tidy caption. Two shapes matter, and they behave differently:
 *
 *   CONTIGUOUS  — the model transcribes the fair's name as one run. Typical of
 *                 a poster with the name on a single line. This resolves.
 *   INTERLEAVED — the model narrates around the name ("the upper arc reads X,
 *                 and beneath that Y"), so the name never appears as one run.
 *                 This does NOT resolve. See the limitation test below.
 *
 * ⚠️ Neither sample is the live specimen's actual OCR output. That text was
 * never stored, the `photo-intake-unresolved` reply does not quote it, and
 * calling the extractor needs an INTERNAL_API_KEY this environment does not
 * hold. So these tests pin the MATCHER'S BEHAVIOUR on both shapes; they do not
 * prove `2bd078bf` would now resolve. That claim needs the real text.
 */
const OCR_CONTIGUOUS = `
The image is a circular badge-style logo with a warm autumnal palette. The
lettering around the badge reads "The Hillsborough County Agricultural Fair"
and along the bottom banner "New Boston, NH". The illustration shows a red
barn, a vintage tractor, a grazing cow, stalks of corn, a large orange pumpkin
and a ferris wheel against rolling hills.
`.repeat(3);

const OCR_INTERLEAVED = `
Around the upper arc, in bold white capitals, it reads "THE HILLSBOROUGH
COUNTY" and beneath that, in large dark green lettering, "AGRICULTURAL FAIR".
Along the bottom arc, on a green banner, it reads "NEW BOSTON, NH".
`.repeat(3);

describe("the specimen shape resolves from image text", () => {
  it("finds the fair when the logo's name transcribes as one run", async () => {
    const db = freshDb();
    seedEvent(db, "Hillsborough County Agricultural Fair", "hillsborough-county-agricultural-fair");

    const hit = await findEventBySubjectName(db, OCR_CONTIGUOUS);
    expect(hit?.slug).toBe("hillsborough-county-agricultural-fair");
  });

  it("works on prose long enough to be a real OCR payload", async () => {
    // The live payload was 1584 chars. A matcher that only behaved on short
    // subject lines would pass every OPE-254 test and still fail this ticket.
    const db = freshDb();
    seedEvent(db, "Hillsborough County Agricultural Fair", "hillsborough-county-agricultural-fair");

    expect(OCR_CONTIGUOUS.length).toBeGreaterThan(1000);
    expect(await findEventBySubjectName(db, OCR_CONTIGUOUS)).not.toBeNull();
  });
});

describe("KNOWN LIMITATION — interleaved lettering does not resolve", () => {
  it("misses the fair when the model narrates between the name's halves", async () => {
    // Not a bug in this change; the inherited contract of the matcher, which
    // requires the event's base slug INTACT and contiguous. Recorded as a
    // passing test rather than a wish, so the boundary is visible and a future
    // widening has something to flip.
    //
    // Widening to an ordered-subsequence match would catch this, and would also
    // let a 2-token slug like `cheshire-fair` match "Cheshire ... fair" spread
    // across unrelated prose. Attaching photos to the wrong fair is a WRONG
    // answer, not a near miss, so that trade is John's to make, not mine.
    const db = freshDb();
    seedEvent(db, "Hillsborough County Agricultural Fair", "hillsborough-county-agricultural-fair");

    expect(await findEventBySubjectName(db, OCR_INTERLEAVED)).toBeNull();
  });
});

describe("the guards are what make long OCR text safe", () => {
  it("ignores a REJECTED tombstone of the same fair", async () => {
    // Prod carries exactly this: `hillsborough-county-agricultural-fair-2026-
    // merged-76585d31`, REJECTED. Matching it would hand the photo to a row
    // whose URL 301s away.
    const db = freshDb();
    seedEvent(
      db,
      "Hillsborough County Agricultural Fair 2026",
      "hillsborough-county-agricultural-fair-2026-merged-76585d31",
      { status: "REJECTED", mergedInto: "e-keeper" }
    );

    expect(await findEventBySubjectName(db, OCR_CONTIGUOUS)).toBeNull();
  });

  it("ignores a TENTATIVE future edition", async () => {
    // Prod also carries `hillsborough-county-agricultural-fair-nh-2027`,
    // TENTATIVE. Only APPROVED rows are attributable.
    const db = freshDb();
    seedEvent(
      db,
      "Hillsborough County Agricultural Fair 2027",
      "hillsborough-county-agricultural-fair-nh-2027",
      { status: "TENTATIVE" }
    );

    expect(await findEventBySubjectName(db, OCR_CONTIGUOUS)).toBeNull();
  });

  it("HOLDS when the text names two independent fairs", async () => {
    // The safe direction, and it matters far more on 1.5 KB of prose than on a
    // subject line: a poster collage or a page of listings can easily name
    // several. Ambiguity must ask, never guess.
    const db = freshDb();
    seedEvent(db, "Hillsborough County Agricultural Fair", "hillsborough-county-agricultural-fair");
    seedEvent(db, "Cheshire Fair", "cheshire-fair-nh");

    const both = OCR_CONTIGUOUS + " Also pictured is the Cheshire Fair NH banner.";
    // Both names appear contiguously, so both are genuinely matchable — which
    // is what makes this a real ambiguity rather than one miss and one hit.
    expect(await findEventBySubjectName(db, both)).toBeNull();
  });

  it("does not let a one-word slug match arbitrary prose", async () => {
    // MIN_NAME_SLUG_LEN + the hyphen guard. Without them, an event slugged
    // `fair` would swallow every image description containing the word.
    const db = freshDb();
    seedEvent(db, "Fair", "fair");

    expect(await findEventBySubjectName(db, OCR_CONTIGUOUS)).toBeNull();
  });

  it("does not match a fair the image never names", async () => {
    const db = freshDb();
    seedEvent(db, "Fryeburg Fair", "fryeburg-fair-2026");

    expect(await findEventBySubjectName(db, OCR_CONTIGUOUS)).toBeNull();
  });
});

describe("the new path is distinguishable from a human override", () => {
  it("reports method 'ocr-name', not 'override'", () => {
    // Folding this into `override` would make the path unmeasurable: an
    // override is a person naming the fair, this is us reading it off an image,
    // and a precision audit has to be able to tell them apart.
    const r = resolveOccurrence({
      overrideEvent: { id: "e-1", name: "Hillsborough County Agricultural Fair", slug: "h-c-a-f" },
      overrideMethod: "ocr-name",
      venues: [],
      events: [],
    });
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.method).toBe("ocr-name");
  });

  it("still defaults to 'override' for every pre-existing caller", () => {
    const r = resolveOccurrence({
      overrideEvent: { id: "e-1", name: "X", slug: "x" },
      venues: [],
      events: [],
    });
    expect(r.status === "resolved" && r.method).toBe("override");
  });
});

describe("the wiring, pinned at source", () => {
  const SRC = readFileSync(join(process.cwd(), "src/email-handlers/photo-intake.ts"), "utf8");

  it("only OCRs on the hold path — a resolved photo must not pay for vision", () => {
    // OPE-325's cost property. If this call escapes its guard, every ordinary
    // "photos from the Cheshire Fair" email starts paying for an extract-image
    // round trip it does not need.
    const idx = SRC.indexOf("poster = await classifyAsPoster");
    expect(idx).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain('resolution.status !== "resolved"');
  });

  it("classifies the image exactly once", () => {
    // The poster branch below reuses the cached result. Two calls would double
    // the vision cost and could return two different verdicts for one image.
    const calls = SRC.split("await classifyAsPoster(").length - 1;
    expect(calls).toBe(1);
  });

  it("reuses findEventBySubjectName rather than adding a second matcher", () => {
    // "A fix wired into one of two parallel paths" is this codebase's recurring
    // failure. One matcher means an improvement to it reaches both callers.
    expect(SRC).toContain("findEventBySubjectName(db, poster.text)");
  });

  it("logs the resolve so precision stays computable", () => {
    expect(SRC).toContain("mcp:photo-intake:ocr-name-resolve");
  });

  it("is fail-soft — a matcher fault must not cost the photo", () => {
    // OPE-404's rule: an identification lookup that throws holds the photo, it
    // does not kill the email.
    const idx = SRC.indexOf("findEventBySubjectName(db, poster.text)");
    expect(SRC.slice(idx, idx + 120)).toContain(".catch(");
  });
});
