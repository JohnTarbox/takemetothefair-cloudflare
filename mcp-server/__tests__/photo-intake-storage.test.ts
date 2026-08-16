/**
 * OPE-403 — the photo-intake ack must never claim more than the system did.
 *
 * The 2026-08-15 failure in one line: five photo emails were matched to the
 * right fair, acknowledged as "Matched to: Winthrop Arts Festival 2026", and
 * stored zero photos — because `runBoothPipeline` returns early when
 * `PHOTO_VISION_ENABLED != "true"`, handing back a `disabledReason` the caller
 * never read.
 *
 * These tests pin the three pieces that make that impossible to repeat:
 *   1. `describePhotoStorage` — the storage verdict, including WHY it is zero.
 *   2. `alreadyAttached`      — the drain's skip decision, which used to ask
 *                               "did we identify a fair?" instead of "did we
 *                               attach the photos?".
 *   3. the ack copy itself    — the only part of this a submitter ever sees.
 */
import { describe, expect, it } from "vitest";
import { describePhotoStorage } from "../src/email-handlers/photo-intake.js";
import { alreadyAttached } from "../src/photo/resolve-held-photos.js";
import { buildReply } from "../src/email-reply-builder.js";
import { parseVisionReply } from "../src/photo/vision.js";
import type { BoothPipelineResult } from "../src/photo/booth-pipeline.js";

/** A pipeline result with everything zeroed; each test overrides what it means. */
function pipeline(over: Partial<BoothPipelineResult> = {}): BoothPipelineResult {
  return {
    examined: 0,
    staged: 0,
    skipped: 0,
    identifiedNames: [],
    galleryAttached: 0,
    galleryFailed: 0,
    autoWritten: [],
    visionFailures: [],
    ...over,
  };
}

describe("describePhotoStorage", () => {
  it("reports the disabled gate as the reason — the exact 2026-08-15 shape", () => {
    // What prod actually returns with PHOTO_VISION_ENABLED="false".
    const out = describePhotoStorage(
      3,
      pipeline({
        disabledReason: 'PHOTO_VISION_ENABLED is not "true" — booth identification is off.',
      })
    );

    expect(out.stored).toBe(0);
    expect(out.offered).toBe(3);
    // The regression that shipped: this was null, so the ack said nothing.
    expect(out.blockedReason).toContain("PHOTO_VISION_ENABLED");
  });

  it("is silent when photos actually landed", () => {
    const out = describePhotoStorage(2, pipeline({ galleryAttached: 2 }));
    expect(out.stored).toBe(2);
    expect(out.blockedReason).toBeNull();
  });

  it("is silent when the sender attached no images at all", () => {
    // Nothing was promised, so there is nothing to explain.
    const out = describePhotoStorage(0, pipeline());
    expect(out.blockedReason).toBeNull();
  });

  it("reports upload failures with a count", () => {
    const out = describePhotoStorage(2, pipeline({ galleryFailed: 2 }));
    expect(out.blockedReason).toBe("2 photo uploads failed");
  });

  it("still names a reason when the pipeline threw", () => {
    // null is what the handler passes when runBoothPipeline threw.
    const out = describePhotoStorage(1, null);
    expect(out.stored).toBe(0);
    expect(out.blockedReason).toContain("errored");
  });

  it("never returns a silent zero — a reasonless no-op still says so", () => {
    // The whole defect class: landed nowhere and explained nothing.
    const out = describePhotoStorage(1, pipeline());
    expect(out.blockedReason).not.toBeNull();
    expect(out.blockedReason).toContain("no reason");
  });

  it("partial success counts as success — one landed photo is not a failure", () => {
    const out = describePhotoStorage(3, pipeline({ galleryAttached: 1, galleryFailed: 2 }));
    expect(out.stored).toBe(1);
    expect(out.blockedReason).toBeNull();
  });

  // ── The false-positive found on the first live photo, 2026-08-16 ──────────
  //
  // The original predicate was `stored === 0`, i.e. "did a gallery row appear".
  // Only the "general fair scene" bucket becomes a gallery row; a photo
  // identified as a BOOTH is staged for review and correctly produces zero. So
  // the happy path would have raised a P0 while the system behaved perfectly.

  it("a STAGED booth is accounted for — no alarm, even with zero gallery rows", () => {
    const out = describePhotoStorage(1, pipeline({ examined: 1, staged: 1 }));
    expect(out.stored).toBe(0); // correct: booths never go to the gallery
    expect(out.accountedFor).toBe(1);
    expect(out.blockedReason).toBeNull(); // the regression this pins
  });

  it("an AUTO-WRITTEN booth is accounted for", () => {
    const out = describePhotoStorage(
      1,
      pipeline({
        examined: 1,
        autoWritten: [{ businessName: "Hilltop Pottery", wasCreated: true }],
      })
    );
    expect(out.accountedFor).toBe(1);
    expect(out.blockedReason).toBeNull();
  });

  it("an auto-write that ERRORED does not count as accounted for", () => {
    // A failed write is not a destination. Counting it would re-hide the bug.
    const out = describePhotoStorage(
      1,
      pipeline({ examined: 1, autoWritten: [{ businessName: "X", error: "insert failed" }] })
    );
    expect(out.accountedFor).toBe(0);
    expect(out.blockedReason).not.toBeNull();
  });

  it("names the vision failure when photos landed nowhere", () => {
    // The live 2026-08-16 shape, minus the staging: vision gave up AND nothing
    // was staged. Previously this said only "reported no reason".
    const out = describePhotoStorage(
      1,
      pipeline({ examined: 1, visionFailures: ["ai-run-threw: 5007 unsupported input"] })
    );
    expect(out.blockedReason).toContain("vision produced nothing usable");
    expect(out.blockedReason).toContain("ai-run-threw");
  });

  it("the gate being off still outranks a vision failure as the explanation", () => {
    // If vision never ran, "the gate is off" is the actionable cause; a
    // downstream symptom would send the reader to the wrong place.
    const out = describePhotoStorage(
      1,
      pipeline({ disabledReason: 'PHOTO_VISION_ENABLED is not "true"', visionFailures: ["x"] })
    );
    expect(out.blockedReason).toContain("PHOTO_VISION_ENABLED");
  });
});

describe("parseVisionReply — five failures that used to look identical", () => {
  // On the first live photo the lane logged "vision model returned nothing
  // usable" and we could not tell whether the model errored, replied in an
  // unexpected shape, or replied in prose. Three different fixes.

  it("empty reply says empty-text AND describes the raw shape", () => {
    const out = parseVisionReply({ result: "oops" });
    expect(out.kind).toBe("unclear");
    expect(out.failureReason).toContain("empty-text");
    // The shape is the actionable half: it tells you which key to read.
    expect(out.failureReason).toContain("response=absent");
  });

  it("prose with no JSON says no-json-span and quotes the start", () => {
    const out = parseVisionReply({ response: "I'm sorry, I can't identify this image." });
    expect(out.failureReason).toContain("no-json-span");
    expect(out.failureReason).toContain("I'm sorry");
  });

  it("malformed JSON says json-parse-failed", () => {
    const out = parseVisionReply({ response: '{"kind": "booth",,,}' });
    expect(out.failureReason).toContain("json-parse-failed");
  });

  it("a null reply is described, not silently coerced", () => {
    expect(parseVisionReply(null).failureReason).toContain("null");
  });

  it("a SUCCESSFUL parse carries no failureReason", () => {
    // The field must stay absent on success, or every staged booth would look
    // like a failure in admin_actions.
    const out = parseVisionReply({
      response: '{"kind":"booth","business_name":"Hilltop Pottery","confidence":0.9}',
    });
    expect(out.kind).toBe("booth");
    expect(out.businessName).toBe("Hilltop Pottery");
    expect(out.failureReason).toBeUndefined();
  });

  it("truncates a runaway reason — it lands in a log line, not a report", () => {
    const out = parseVisionReply({ response: "x".repeat(5000) });
    expect(out.failureReason!.length).toBeLessThanOrEqual(200);
  });
});

describe("alreadyAttached — the drain's skip decision", () => {
  it("does NOT skip an acked-but-unstored row (the bug)", () => {
    // Precisely the five 2026-08-15 rows once the column is populated: the fair
    // was decided, nothing was stored. The old guard skipped these.
    expect(alreadyAttached({ resultingEventId: "evt-winthrop", photosStored: 0 })).toBe(false);
  });

  it("skips a row whose photos really did land", () => {
    expect(alreadyAttached({ resultingEventId: "evt-winthrop", photosStored: 4 })).toBe(true);
  });

  it("falls back to the legacy proxy when the count is NULL", () => {
    // Pre-drizzle/0191 rows have no count. Treating them as unattached would
    // re-attach their photos, and attachGeneralPhotos is not dedup'd — so a
    // resolved legacy row MUST still skip.
    expect(alreadyAttached({ resultingEventId: "evt-waterford", photosStored: null })).toBe(true);
    expect(alreadyAttached({ resultingEventId: null, photosStored: null })).toBe(false);
  });

  it("the stored count outranks the legacy proxy once it exists", () => {
    // A populated 0 is a stronger statement than "an event id is present".
    expect(alreadyAttached({ resultingEventId: "evt-x", photosStored: 0 })).toBe(false);
  });
});

describe("photo-intake-ack copy", () => {
  const base = {
    subject: "Booths at the fair",
    photoCount: 3,
    resolvedEventName: "Winthrop Arts Festival 2026",
    matchMethod: "exif",
    matchedDate: "2026-08-15",
  };

  it("says plainly that nothing was published when nothing was stored", () => {
    const msg = buildReply("photo-intake-ack", "john@example.com", {
      ...base,
      photosStored: 0,
      photosStorageBlocked: 'PHOTO_VISION_ENABLED is not "true"',
    });

    expect(msg.text).toContain("Not published yet");
    expect(msg.text).toContain("not on the site");
    // The fair match is still reported — it was correct, and suppressing it
    // would lose the one thing the lane got right.
    expect(msg.text).toContain("Winthrop Arts Festival 2026");
  });

  it("does not leak the internal flag name to the submitter", () => {
    const msg = buildReply("photo-intake-ack", "john@example.com", {
      ...base,
      photosStored: 0,
      photosStorageBlocked: 'PHOTO_VISION_ENABLED is not "true"',
    });
    expect(msg.text).not.toContain("PHOTO_VISION_ENABLED");
  });

  it("promises no timeline — the OPE-367 mistake, not repeated", () => {
    const msg = buildReply("photo-intake-ack", "john@example.com", {
      ...base,
      photosStored: 0,
      photosStorageBlocked: "gate off",
    });
    // "queued for review" is a fact the flagged row keeps. A promise about WHEN
    // is not, and is what OPE-367 had to rewrite out of the support-ack.
    expect(msg.text).toContain("queued for review");
    expect(msg.text).not.toMatch(/shortly|within \d|soon|we will publish/i);
  });

  it("reports the gallery count when photos DID land", () => {
    const msg = buildReply("photo-intake-ack", "john@example.com", {
      ...base,
      photosStored: 3,
      photosStorageBlocked: null,
    });
    expect(msg.text).toContain("Added to the fair's photo gallery: 3 photos");
    expect(msg.text).not.toContain("Not published yet");
  });

  it("singular/plural reads correctly for one photo", () => {
    const msg = buildReply("photo-intake-ack", "john@example.com", {
      ...base,
      photoCount: 1,
      photosStored: 0,
      photosStorageBlocked: "gate off",
    });
    expect(msg.text).toContain("this photo is");
    expect(msg.text).not.toContain("these photos are");
  });

  it("a pre-OPE-403 caller that sets neither param still renders", () => {
    // Back-compat: the params are additive, and an older caller must not crash
    // or emit a bare "Added to the gallery: 0 photos".
    const msg = buildReply("photo-intake-ack", "john@example.com", base);
    expect(msg.text).toContain("Winthrop Arts Festival 2026");
    expect(msg.text).not.toContain("Added to the fair's photo gallery");
    expect(msg.text).not.toContain("Not published yet");
  });
});
