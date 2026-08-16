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
    // The whole defect class: stored 0 and explained nothing.
    const out = describePhotoStorage(1, pipeline());
    expect(out.blockedReason).not.toBeNull();
    expect(out.blockedReason).toContain("no reason");
  });

  it("partial success counts as success — one landed photo is not a failure", () => {
    const out = describePhotoStorage(3, pipeline({ galleryAttached: 1, galleryFailed: 2 }));
    expect(out.stored).toBe(1);
    expect(out.blockedReason).toBeNull();
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
