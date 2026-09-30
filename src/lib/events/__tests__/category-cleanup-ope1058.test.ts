/**
 * OPE-1058 scope 2 — the one-time rewrite, tested before it touches prod.
 *
 * John ratified the mapping on 2026-09-17. These pin the cases that decide
 * whether a row comes out right: the one-to-many split, the "Other" vs "Event"
 * distinction, tag rescue, and idempotency — a bulk mutation that is not safe to
 * re-run is a landmine on the first partial failure
 * (docs/bulk-mutation-discipline.md).
 */
import { describe, it, expect } from "vitest";
import { cleanupEventCategories, CATEGORY_CLEANUP_MAP } from "../category-cleanup";
import { EVENT_CATEGORIES, UNCATEGORIZED_EVENT_CATEGORY } from "@takemetothefair/constants";

describe("OPE-1058 — the cleanup mapping", () => {
  it("every target it maps TO is a real category (or a deliberate removal)", () => {
    for (const [from, to] of Object.entries(CATEGORY_CLEANUP_MAP)) {
      for (const target of to) {
        expect(EVENT_CATEGORIES as readonly string[], `${from} → ${target}`).toContain(target);
      }
    }
  });

  it("fixes the typo that started this — Craft Fsir", () => {
    expect(cleanupEventCategories(["Craft Fsir"]).categories).toEqual(["Craft Fair"]);
  });

  it("splits Holiday Craft Fair into both of its parts", () => {
    expect(cleanupEventCategories(["Holiday Craft Fair"]).categories).toEqual([
      "Holiday Market",
      "Craft Fair",
    ]);
  });

  it("de-duplicates when a mapping collides with a value already present", () => {
    // Wedding Show and Wedding Expo both become Bridal Show; a row carrying all
    // three must not end with Bridal Show three times.
    expect(
      cleanupEventCategories(["Bridal Show", "Wedding Show", "Wedding Expo"]).categories
    ).toEqual(["Bridal Show"]);
  });

  it("rescues the tag-worthy values as TAGS and drops the rest", () => {
    const r = cleanupEventCategories(["Craft Fair", "Family-Friendly", "gifts"]);
    expect(r.categories).toEqual(["Craft Fair"]);
    expect(r.addTags).toEqual(["family-friendly"]);
  });

  it("a row emptied by the mapping becomes Other, not the Event placeholder", () => {
    // Someone DID categorise this row; they used a word the taxonomy lacks.
    // "Event" means nobody ever categorised it, and the admin uncategorized
    // queue reads it that way.
    const r = cleanupEventCategories(["Family-Friendly"]);
    expect(r.categories).toEqual(["Other"]);
    expect(r.addTags).toEqual(["family-friendly"]);
  });

  it("an uncategorised row STAYS uncategorised", () => {
    const r = cleanupEventCategories([UNCATEGORIZED_EVENT_CATEGORY]);
    expect(r.categories).toEqual([UNCATEGORIZED_EVENT_CATEGORY]);
    expect(r.changed).toBe(false);
  });

  it("leaves an already-clean row untouched and reports changed=false", () => {
    const r = cleanupEventCategories(["Craft Fair", "Festival"]);
    expect(r.categories).toEqual(["Craft Fair", "Festival"]);
    expect(r.changed).toBe(false);
  });

  it("is idempotent — the second pass is a no-op", () => {
    const once = cleanupEventCategories(["Cultural", "Hamfest", "Family-Friendly"]);
    expect(once.categories).toEqual(["Cultural Festival", "Amateur Radio Convention"]);
    const twice = cleanupEventCategories(once.categories);
    expect(twice.categories).toEqual(once.categories);
    expect(twice.changed).toBe(false);
  });

  it("keeps an unanticipated value rather than silently dropping it", () => {
    // The read-back asserts the end state; a survivor has to be visible there,
    // not disappear into the rewrite.
    const r = cleanupEventCategories(["Craft Fair", "Something Nobody Predicted"]);
    expect(r.categories).toEqual(["Craft Fair", "Something Nobody Predicted"]);
  });

  it("maps the ten absorbed values onto the categories that replaced them", () => {
    const pairs: Array<[string, string]> = [
      ["Hamfest", "Amateur Radio Convention"],
      ["Outdoor Market", "Market"],
      ["Sidewalk Sale", "Market"],
      ["Sportsmen's Show", "Outdoor Show"],
      ["RV Show", "Outdoor Show"],
      ["RV & Camping Show", "Outdoor Show"],
      ["Pop Culture", "Pop Culture Convention"],
      ["Renaissance Faire", "Renaissance Fair"],
      ["Model Train Show", "Hobby Show"],
      ["Historical", "Living History"],
    ];
    for (const [from, to] of pairs) {
      expect(cleanupEventCategories([from]).categories, from).toEqual([to]);
    }
  });
});

describe("OPE-1058 — 'Other' is a last resort, not a co-label", () => {
  it("drops a mapped Other when real categories survive (the dragon boat row)", () => {
    expect(cleanupEventCategories(["Festival", "Cultural Festival", "Sports"]).categories).toEqual([
      "Festival",
      "Cultural Festival",
    ]);
  });

  it("keeps Other when it is all that is left", () => {
    expect(cleanupEventCategories(["Sports", "Road Race"]).categories).toEqual(["Other"]);
  });

  it("keeps an Other the row already carried", () => {
    expect(cleanupEventCategories(["Other", "Sports"]).categories).toEqual(["Other"]);
  });
});
