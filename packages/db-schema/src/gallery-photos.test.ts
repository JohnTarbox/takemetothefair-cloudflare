import { describe, it, expect } from "vitest";
import {
  applyRotation,
  rotationCdnOption,
  pickFeaturedSuccessor,
  isGalleryRotation,
  sha256Hex,
} from "./gallery-photos";

describe("applyRotation — relative, because that is how an operator thinks", () => {
  it("turns a quarter at a time", () => {
    expect(applyRotation(0, 90)).toBe(90);
    expect(applyRotation(90, 90)).toBe(180);
    expect(applyRotation(270, 90)).toBe(0);
  });

  it("accepts a negative turn as 'put it back'", () => {
    expect(applyRotation(90, -90)).toBe(0);
    expect(applyRotation(0, -90)).toBe(270);
  });

  it("wraps past a full turn instead of accumulating", () => {
    expect(applyRotation(180, 360)).toBe(180);
    expect(applyRotation(90, 630)).toBe(0);
  });

  it("refuses an angle that does not land on a quarter", () => {
    // cdn-cgi/image accepts only 90/180/270. Storing 45 would render
    // unrotated with no error anywhere — a silent no-op is worse than a throw.
    expect(() => applyRotation(0, 45)).toThrow(/0, 90, 180 or 270/);
  });
});

describe("rotationCdnOption — 0 must not appear in the options string", () => {
  it("returns undefined at zero", () => {
    // The options string IS the CDN cache key. Emitting `rotate=0` on every
    // unrotated image would invalidate every derivative cached for the whole
    // site the moment this shipped.
    expect(rotationCdnOption(0)).toBeUndefined();
    expect(rotationCdnOption(null)).toBeUndefined();
    expect(rotationCdnOption(undefined)).toBeUndefined();
    expect(rotationCdnOption(360)).toBeUndefined();
  });

  it("returns the angle when there is one", () => {
    expect(rotationCdnOption(90)).toBe(90);
    expect(rotationCdnOption(270)).toBe(270);
    expect(rotationCdnOption(-90)).toBe(270);
  });

  it("drops a corrupt stored value rather than emitting an invalid option", () => {
    // A bad row must degrade to "unrotated", not to a URL cdn-cgi rejects,
    // which would 404 the image rather than showing it the wrong way up.
    expect(rotationCdnOption(45)).toBeUndefined();
    expect(rotationCdnOption(Number.NaN)).toBeUndefined();
  });
});

describe("isGalleryRotation", () => {
  it("accepts exactly the four quarters", () => {
    expect([0, 90, 180, 270].every(isGalleryRotation)).toBe(true);
    expect([45, 1, 359, -90].some(isGalleryRotation)).toBe(false);
  });
});

describe("pickFeaturedSuccessor", () => {
  const photo = (
    id: string,
    sortOrder: number,
    isFeatured = false,
    deletedAt: Date | null = null
  ) => ({
    id,
    sortOrder,
    isFeatured,
    deletedAt,
  });

  it("promotes the lowest remaining sort_order when the featured one goes", () => {
    const out = pickFeaturedSuccessor([photo("a", 0, true), photo("c", 2), photo("b", 1)], "a");
    expect(out?.id).toBe("b");
  });

  it("changes nothing when the deleted photo was not featured", () => {
    // Otherwise every ordinary delete would silently re-lead the gallery.
    expect(pickFeaturedSuccessor([photo("a", 0, true), photo("b", 1)], "b")).toBeNull();
  });

  it("returns null when the gallery is left empty", () => {
    expect(pickFeaturedSuccessor([photo("a", 0, true)], "a")).toBeNull();
  });

  it("never promotes an already-deleted photo", () => {
    // The tombstones stay in the table, so a successor search that ignored
    // deleted_at would happily re-feature a photo somebody removed earlier.
    const out = pickFeaturedSuccessor(
      [photo("a", 0, true), photo("gone", 1, false, new Date()), photo("live", 2)],
      "a"
    );
    expect(out?.id).toBe("live");
  });

  it("breaks a sort_order tie deterministically by id", () => {
    // Same delete, same gallery, same answer on retry. A tie broken by array
    // order would depend on the SELECT's row order and make the operation
    // untestable.
    const a = pickFeaturedSuccessor([photo("x", 0, true), photo("m", 5), photo("d", 5)], "x");
    const b = pickFeaturedSuccessor([photo("x", 0, true), photo("d", 5), photo("m", 5)], "x");
    expect(a?.id).toBe("d");
    expect(b?.id).toBe("d");
  });

  it("returns null for an id that is not in the gallery", () => {
    expect(pickFeaturedSuccessor([photo("a", 0, true)], "nope")).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty input", () => {
    return expect(sha256Hex(new Uint8Array())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("gives identical digests for identical bytes and different for different", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(c));
  });

  it("hashes a view, not its whole backing buffer", async () => {
    // A Uint8Array from a larger ArrayBuffer carries a byteOffset. Passing the
    // backing buffer straight to subtle.digest would hash the neighbouring
    // bytes too, so two identical photos sliced out of different buffers would
    // get different digests and dedup would never fire.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    expect(await sha256Hex(view)).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
  });
});
