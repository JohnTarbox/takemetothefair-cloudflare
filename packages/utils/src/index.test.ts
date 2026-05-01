import { describe, it, expect } from "vitest";
import { decodeHtmlEntities, createSlug, createSlugFromName } from "./index";

describe("decodeHtmlEntities", () => {
  it("decodes ampersands", () => {
    expect(decodeHtmlEntities("Earth Expo &amp; Convention")).toBe("Earth Expo & Convention");
  });

  it("decodes quotes and apostrophes", () => {
    expect(decodeHtmlEntities("&quot;Hello&quot; he said")).toBe('"Hello" he said');
    expect(decodeHtmlEntities("don&#039;t")).toBe("don't");
    expect(decodeHtmlEntities("don&apos;t")).toBe("don't");
  });

  it("decodes angle brackets", () => {
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>");
  });

  it("decodes non-breaking spaces", () => {
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes numeric entities (decimal)", () => {
    expect(decodeHtmlEntities("&#65;&#66;&#67;")).toBe("ABC");
  });

  it("decodes numeric entities (hex)", () => {
    expect(decodeHtmlEntities("&#x41;&#x42;")).toBe("AB");
  });

  it("returns empty string unchanged", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(decodeHtmlEntities("plain text no entities")).toBe("plain text no entities");
  });
});

describe("createSlug (canonical, slugify-backed)", () => {
  it("converts text to lowercase slug", () => {
    expect(createSlug("Hello World")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(createSlug("Test! Event @ Fair")).toBe("test-event-fair");
  });

  it("trims whitespace", () => {
    expect(createSlug("  Hello World  ")).toBe("hello-world");
  });

  it("folds accented chars to ASCII", () => {
    expect(createSlug("Café Olé")).toBe("cafe-ole");
  });

  it("handles ampersands by transliterating to 'and' (slugify default)", () => {
    expect(createSlug("R&D Department")).toBe("randd-department");
  });
});

describe("createSlugFromName (legacy, scraper-stable)", () => {
  it("converts text to lowercase slug", () => {
    expect(createSlugFromName("Hello World")).toBe("hello-world");
  });

  it("collapses non-alphanumeric runs to a single hyphen", () => {
    expect(createSlugFromName("Test!! Event @@ Fair")).toBe("test-event-fair");
  });

  it("trims hyphens at the boundaries", () => {
    expect(createSlugFromName("---Hello World---")).toBe("hello-world");
  });

  it("preserves accented chars unchanged (legacy behavior)", () => {
    // Distinct from createSlug — accented chars stay in the slug as
    // non-alphanum characters, which collapse to "-". This is the exact
    // legacy behavior; changing it would break scraper sourceId stability.
    expect(createSlugFromName("Café Olé")).toBe("caf-ol");
  });
});
