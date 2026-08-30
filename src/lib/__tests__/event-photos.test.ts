import { describe, it, expect } from "vitest";
import { resolvePhotoAlt, orderEventPhotos, buildEventSchemaImages } from "../event-photos";

describe("resolvePhotoAlt — never an empty alt (OPE-212)", () => {
  it("uses the alt text when present", () => {
    expect(resolvePhotoAlt("Midway at dusk", "cap", "Fryeburg Fair")).toBe("Midway at dusk");
  });

  it("falls back to the caption, per John's guardrail", () => {
    expect(resolvePhotoAlt(null, "The grandstand", "Fryeburg Fair")).toBe("The grandstand");
    expect(resolvePhotoAlt("", "The grandstand", "Fryeburg Fair")).toBe("The grandstand");
  });

  it("falls back to the event name rather than emitting an empty alt", () => {
    // `alt=""` is NOT neutral — it tells a screen reader the image is
    // decorative and to skip it, which is a lie about a photo of the fair.
    expect(resolvePhotoAlt(null, null, "Fryeburg Fair")).toBe("Photo from Fryeburg Fair");
    expect(resolvePhotoAlt("", "", "Fryeburg Fair")).toBe("Photo from Fryeburg Fair");
  });

  it("treats whitespace-only as blank", () => {
    // A space-only alt passes a `!alt` check and still announces nothing.
    expect(resolvePhotoAlt("   ", "  ", "Fryeburg Fair")).toBe("Photo from Fryeburg Fair");
    expect(resolvePhotoAlt("  \t\n ", "Real caption", "Fryeburg Fair")).toBe("Real caption");
  });

  it("never returns an empty string for any input combination", () => {
    for (const alt of [null, undefined, "", "  "]) {
      for (const caption of [null, undefined, "", "  "]) {
        expect(resolvePhotoAlt(alt, caption, "X Fair").length).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildEventSchemaImages (OPE-212 §4)", () => {
  const hero = "https://cdn.example/hero.webp";

  it("keeps the SCALAR shape when there are no gallery photos", () => {
    // John: "single-image events keep the current shape". Changing every
    // event's `image` to an array would rewrite markup on thousands of correct
    // pages and force a re-crawl for no benefit.
    expect(buildEventSchemaImages(hero, [])).toBe(hero);
  });

  it("emits an ImageObject array with the hero FIRST", () => {
    const out = buildEventSchemaImages(hero, [
      { url: "https://cdn.example/a.webp", alt: "A" },
      { url: "https://cdn.example/b.webp", alt: "B" },
    ]);
    expect(Array.isArray(out)).toBe(true);
    const arr = out as Array<Record<string, string>>;
    expect(arr).toHaveLength(3);
    expect(arr[0]).toEqual({ "@type": "ImageObject", url: hero });
    expect(arr[1].url).toBe("https://cdn.example/a.webp");
  });

  it("does not repeat the hero when it also appears in the gallery", () => {
    const out = buildEventSchemaImages(hero, [
      { url: hero, alt: "same" },
      { url: "https://cdn.example/a.webp", alt: "A" },
    ]);
    const arr = out as Array<Record<string, string>>;
    expect(arr.filter((i) => i.url === hero)).toHaveLength(1);
    expect(arr).toHaveLength(2);
  });

  it("stays SCALAR when every gallery photo duplicates the hero", () => {
    // A one-element array would be a shape change that adds nothing.
    expect(buildEventSchemaImages(hero, [{ url: hero, alt: "same" }])).toBe(hero);
  });

  it("de-duplicates repeated gallery urls", () => {
    const out = buildEventSchemaImages(hero, [
      { url: "https://cdn.example/a.webp", alt: "A" },
      { url: "https://cdn.example/a.webp", alt: "A again" },
    ]);
    expect(out as unknown[]).toHaveLength(2);
  });

  it("emits a real caption but never the alt fallback as one", () => {
    // `caption` is a schema.org property a human wrote. Emitting synthesised
    // alt text there would put "Photo from X Fair" in front of a reader as if
    // the photographer had written it.
    const out = buildEventSchemaImages(hero, [
      { url: "https://cdn.example/a.webp", alt: "Photo from X Fair", caption: "The midway" },
      { url: "https://cdn.example/b.webp", alt: "Photo from X Fair" },
    ]);
    const arr = out as Array<Record<string, string>>;
    expect(arr[1].caption).toBe("The midway");
    expect(arr[2].caption).toBeUndefined();
  });
});

describe("orderEventPhotos", () => {
  const p = (id: string, isFeatured = false) => ({ id, isFeatured });

  it("puts the featured photo first", () => {
    expect(orderEventPhotos([p("a"), p("b", true), p("c")])[0].id).toBe("b");
  });

  it("preserves stored order otherwise", () => {
    expect(orderEventPhotos([p("a"), p("b"), p("c")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [p("a"), p("b", true)];
    orderEventPhotos(input);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
