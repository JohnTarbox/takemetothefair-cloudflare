/**
 * OPE-686 — the rotation has to reach the URL, or the feature is inert.
 *
 * This is the defect class the repo keeps hitting: shipped, green, and silently
 * not executing. A rotation stored in D1 that never becomes `rotate=` in the
 * transform URL leaves the photo sideways and the tool looking broken, with
 * every unit test still passing.
 *
 * The `#rot=` fragment exists because Next/Image's loader contract passes only
 * `{src, width, quality}` — there is no fourth argument — and pre-building the
 * transform URL in the component instead would collapse the responsive srcSet,
 * since `cdnImage` returns an already-transformed URL unchanged.
 */
import { describe, it, expect } from "vitest";
import imageLoader, { parseRotationFragment } from "../image-loader";

const SRC = "https://cdn.meetmeatthefair.com/events/e1/photos/photo-1.webp";

describe("parseRotationFragment", () => {
  it("splits the fragment off the source", () => {
    expect(parseRotationFragment(`${SRC}#rot=90`)).toEqual({ src: SRC, rotate: 90 });
  });

  it("leaves an ordinary URL untouched", () => {
    expect(parseRotationFragment(SRC)).toEqual({ src: SRC, rotate: undefined });
  });

  it("drops a rotation of 0 rather than emitting rotate=0", () => {
    // The options string is the CDN cache key; `rotate=0` everywhere would
    // invalidate every derivative already cached for the site.
    expect(parseRotationFragment(`${SRC}#rot=0`)).toEqual({ src: SRC, rotate: undefined });
  });

  it("ignores a corrupt fragment instead of emitting an invalid option", () => {
    // A bad value must degrade to "unrotated", not to a URL cdn-cgi rejects —
    // which would 404 the image rather than show it the wrong way up.
    expect(parseRotationFragment(`${SRC}#rot=45`).rotate).toBeUndefined();
    expect(parseRotationFragment(`${SRC}#rot=abc`).rotate).toBeUndefined();
  });
});

describe("imageLoader", () => {
  it("emits rotate= for a rotated photo, alongside the usual defaults", () => {
    const url = imageLoader({ src: `${SRC}#rot=270`, width: 640 });
    expect(url).toContain("rotate=270");
    expect(url).toContain("width=640");
    expect(url).toContain("quality=80");
    expect(url).toContain("onerror=redirect");
    // The fragment must not survive into the transform URL's source segment.
    expect(url).not.toContain("#rot=");
  });

  it("emits no rotate= for an upright photo", () => {
    expect(imageLoader({ src: SRC, width: 640 })).not.toContain("rotate=");
  });

  it("still varies by width, so the responsive srcSet is real", () => {
    // The reason the rotation is a fragment rather than a pre-built URL: a
    // pre-built transform URL comes back from cdnImage unchanged, and every
    // srcSet entry would point at the same derivative.
    const a = imageLoader({ src: `${SRC}#rot=90`, width: 400 });
    const b = imageLoader({ src: `${SRC}#rot=90`, width: 1200 });
    expect(a).not.toBe(b);
    expect(a).toContain("width=400");
    expect(b).toContain("width=1200");
  });
});
