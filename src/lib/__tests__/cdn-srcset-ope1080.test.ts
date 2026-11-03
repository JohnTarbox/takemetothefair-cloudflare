import { describe, expect, it } from "vitest";
import {
  cdnImage,
  cdnSrcSet,
  cdnVariesByWidth,
  MAX_SRCSET_WIDTH,
  THUMB_WIDTHS,
  thumbOpts,
  CARD_THUMB,
} from "../cdn-image";

/**
 * OPE-1080 — a srcset's candidate URLs must TRACK their width descriptors.
 *
 * Parse with a regex that tolerates commas INSIDE the cdn-cgi option string
 * (the ticket's first measurement split on "," and called every srcset broken).
 */
function parseSrcSet(srcset: string): Array<{ url: string; w: number }> {
  return [...srcset.matchAll(/(\S+)\s+(\d+)w(?:,\s*|$)/g)].map((m) => ({
    url: m[1],
    w: Number(m[2]),
  }));
}

function param(url: string, key: string): number | undefined {
  const m = url.match(new RegExp(`/cdn-cgi/image/[^/]*\\b${key}=(\\d+)`));
  return m ? Number(m[1]) : undefined;
}

const PHOTO =
  "https://cdn.meetmeatthefair.com/events/8f4323d5-213f-4ebf-8a42-71a81fa3cf98/photos/p.webp";

describe("cdnSrcSet — thumbnail ladder (the gallery's shape)", () => {
  const srcset = cdnSrcSet(PHOTO, THUMB_WIDTHS, (w) => thumbOpts(w))!;
  const cands = parseSrcSet(srcset);

  it("emits one candidate per ladder width, 400/800/1200", () => {
    expect(cands.map((c) => c.w)).toEqual([400, 800, 1200]);
  });

  it("each candidate's width param equals its descriptor", () => {
    for (const c of cands) expect(param(c.url, "width")).toBe(c.w);
  });

  it("each candidate's height is round(w*2/3) — same 3:2 crop at every width", () => {
    for (const c of cands) expect(param(c.url, "height")).toBe(Math.round((c.w * 2) / 3));
  });

  it("every candidate URL is distinct", () => {
    expect(new Set(cands.map((c) => c.url)).size).toBe(cands.length);
  });

  it("keeps fit=cover, gravity=auto, format=auto, quality=80, onerror=redirect", () => {
    for (const c of cands) {
      expect(c.url).toContain("fit=cover");
      expect(c.url).toContain("gravity=auto");
      expect(c.url).toContain("format=auto");
      expect(c.url).toContain("quality=80");
      expect(c.url).toContain("onerror=redirect");
    }
  });

  it("threads rotation into every candidate (OPE-686)", () => {
    const rotated = parseSrcSet(
      cdnSrcSet(PHOTO, THUMB_WIDTHS, (w) => thumbOpts(w, { rotate: 90 }))!
    );
    expect(rotated).toHaveLength(3);
    for (const c of rotated) expect(c.url).toContain("rotate=90");
  });

  it("thumbOpts keeps the CARD_THUMB 3:2 ratio", () => {
    expect(CARD_THUMB.width / CARD_THUMB.height).toBeCloseTo(3 / 2, 2);
    const o = thumbOpts(600);
    expect(o.width / o.height!).toBeCloseTo(3 / 2, 2);
  });
});

describe("cdnSrcSet — refuses to build a degenerate srcset", () => {
  it("returns undefined for a foreign hotlink (cdnImage passes it through unchanged)", () => {
    expect(
      cdnSrcSet(
        "https://www.jotform.com/uploads/thegrove207/form_files/TheArtisansGroveLogo.png",
        [400, 600, 800, 1200],
        (w) => thumbOpts(w)
      )
    ).toBeUndefined();
    expect(
      cdnSrcSet(
        "https://images.humanitix.com/i/DnMejx8PSH2mmutqsAwK@seo-500.jpg",
        [400, 800],
        (w) => thumbOpts(w)
      )
    ).toBeUndefined();
  });

  it("returns undefined for an already-transformed /cdn-cgi/image/ URL (the gallery's old input)", () => {
    const pre = cdnImage(PHOTO, CARD_THUMB);
    expect(cdnSrcSet(pre, THUMB_WIDTHS, (w) => thumbOpts(w))).toBeUndefined();
  });

  it("returns undefined for empty / null src", () => {
    expect(cdnSrcSet(null, THUMB_WIDTHS, (w) => thumbOpts(w))).toBeUndefined();
    expect(cdnSrcSet("", THUMB_WIDTHS, (w) => thumbOpts(w))).toBeUndefined();
  });

  it("throws when optsFor ignores the requested width", () => {
    expect(() => cdnSrcSet(PHOTO, [400, 800], () => ({ ...CARD_THUMB }))).toThrow(/width=600/);
  });

  it(`throws above MAX_SRCSET_WIDTH (${MAX_SRCSET_WIDTH}) — no 3840-class widths`, () => {
    expect(() => cdnSrcSet(PHOTO, [400, 3840], (w) => thumbOpts(w))).toThrow(/3840/);
  });

  it("Google user-content varies by width (=wN), so it keeps a srcset", () => {
    const g = "https://lh3.googleusercontent.com/p/abc=s4800";
    const out = parseSrcSet(cdnSrcSet(g, [400, 800], (w) => ({ width: w }))!);
    expect(out.map((c) => c.url)).toEqual([
      "https://lh3.googleusercontent.com/p/abc=w400",
      "https://lh3.googleusercontent.com/p/abc=w800",
    ]);
  });
});

describe("cdnVariesByWidth", () => {
  it.each([
    [PHOTO, true],
    [`${PHOTO}#rot=90`, true],
    ["https://meetmeatthefair.com/og-default.png", true],
    ["https://lh3.googleusercontent.com/a/x", true],
    ["https://www.jotform.com/x.png", false],
    ["https://graph.facebook.com/1/picture", false],
    [cdnImage(PHOTO, CARD_THUMB), false],
    ["/og-default.png", false],
    ["blob:https://meetmeatthefair.com/abc", false],
    ["", false],
  ])("%s → %s", (src, want) => {
    expect(cdnVariesByWidth(src)).toBe(want);
  });
});
