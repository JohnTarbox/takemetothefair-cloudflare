import { describe, it, expect } from "vitest";
import { parseLegacyGallery, orderGalleryPhotos } from "../vendor-photos";

describe("parseLegacyGallery (OPE-211 increment 2)", () => {
  it("reads the legacy {url, alt, caption} shape", () => {
    const out = parseLegacyGallery(
      JSON.stringify([{ url: "/a.webp", alt: "Booth", caption: "Our booth" }])
    );
    expect(out).toEqual([
      {
        id: null,
        url: "/a.webp",
        alt: "Booth",
        caption: "Our booth",
        isFeatured: false,
        isLegacy: true,
      },
    ]);
  });

  it("marks legacy entries so the UI knows they are not editable", () => {
    // A legacy entry has no vendor_photos row, so there is nothing to PATCH or
    // DELETE. Rendering an edit control for it would 404 on click.
    const [only] = parseLegacyGallery(JSON.stringify([{ url: "/a.webp" }]));
    expect(only.isLegacy).toBe(true);
    expect(only.id).toBeNull();
  });

  it("returns empty for malformed JSON rather than throwing", () => {
    // This is a real state in the column. The previous inline reader swallowed
    // it correctly but nothing pinned the behaviour.
    expect(parseLegacyGallery("{not json")).toEqual([]);
    expect(parseLegacyGallery("")).toEqual([]);
    expect(parseLegacyGallery(null)).toEqual([]);
    expect(parseLegacyGallery(undefined)).toEqual([]);
  });

  it("returns empty when the JSON parses to a non-array", () => {
    expect(parseLegacyGallery('{"url":"/a.webp"}')).toEqual([]);
    expect(parseLegacyGallery('"a string"')).toEqual([]);
    expect(parseLegacyGallery("42")).toEqual([]);
  });

  it("drops entries with no usable url instead of rendering a broken image", () => {
    const out = parseLegacyGallery(
      JSON.stringify([{ alt: "no url" }, { url: 42 }, null, "x", { url: "/good.webp" }])
    );
    expect(out.map((p) => p.url)).toEqual(["/good.webp"]);
  });

  it("does NOT cap the number of photos", () => {
    // The old reader hard-capped at 2 (`slice(0, 2)`), a Phase-1 placeholder
    // from when this column was the only store. Dropping a vendor's third
    // photo silently would make the upload UI look broken to whoever just
    // added it.
    const many = Array.from({ length: 7 }, (_, i) => ({ url: `/p${i}.webp` }));
    expect(parseLegacyGallery(JSON.stringify(many))).toHaveLength(7);
  });
});

describe("orderGalleryPhotos", () => {
  const p = (url: string, isFeatured = false) => ({
    id: url,
    url,
    alt: "",
    isFeatured,
    isLegacy: false,
  });

  it("puts a featured photo first", () => {
    const out = orderGalleryPhotos([p("/a"), p("/b", true), p("/c")]);
    expect(out[0].url).toBe("/b");
  });

  it("preserves the incoming order among non-featured photos", () => {
    // The query already applies ORDER BY sort_order; this must not reshuffle
    // it, or a vendor's manual ordering would be silently discarded.
    const out = orderGalleryPhotos([p("/a"), p("/b"), p("/c")]);
    expect(out.map((x) => x.url)).toEqual(["/a", "/b", "/c"]);
  });

  it("preserves relative order among multiple featured photos", () => {
    const out = orderGalleryPhotos([p("/a"), p("/b", true), p("/c", true), p("/d")]);
    expect(out.map((x) => x.url)).toEqual(["/b", "/c", "/a", "/d"]);
  });

  it("does not mutate its input", () => {
    const input = [p("/a"), p("/b", true)];
    orderGalleryPhotos(input);
    expect(input.map((x) => x.url)).toEqual(["/a", "/b"]);
  });
});
