import { describe, it, expect } from "vitest";
import {
  EVENT_STATUS,
  UNCATEGORIZED_EVENT_CATEGORY,
  isEventCategory,
  partitionEventCategories,
  invalidEventCategories,
  EVENT_STATUS_VALUES,
  PUBLIC_EVENT_STATUSES,
  EVENT_VENDOR_STATUS,
  EVENT_VENDOR_STATUS_VALUES,
  PUBLIC_VENDOR_STATUSES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  VENDOR_STATUS_TRANSITIONS,
  EVENT_CATEGORIES,
} from "./index";

describe("status enum shape", () => {
  it("EVENT_STATUS_VALUES has every key from EVENT_STATUS", () => {
    expect(EVENT_STATUS_VALUES.length).toBe(Object.keys(EVENT_STATUS).length);
    for (const v of Object.values(EVENT_STATUS)) {
      expect(EVENT_STATUS_VALUES).toContain(v);
    }
  });

  it("EVENT_VENDOR_STATUS_VALUES has every key from EVENT_VENDOR_STATUS", () => {
    expect(EVENT_VENDOR_STATUS_VALUES.length).toBe(Object.keys(EVENT_VENDOR_STATUS).length);
  });

  it("PAYMENT_STATUS_VALUES has every key from PAYMENT_STATUS", () => {
    expect(PAYMENT_STATUS_VALUES.length).toBe(Object.keys(PAYMENT_STATUS).length);
  });

  it("PUBLIC_EVENT_STATUSES is a subset of EVENT_STATUS_VALUES", () => {
    for (const s of PUBLIC_EVENT_STATUSES) {
      expect(EVENT_STATUS_VALUES).toContain(s);
    }
  });

  it("PUBLIC_VENDOR_STATUSES is a subset of EVENT_VENDOR_STATUS_VALUES", () => {
    for (const s of PUBLIC_VENDOR_STATUSES) {
      expect(EVENT_VENDOR_STATUS_VALUES).toContain(s);
    }
  });
});

describe("VENDOR_STATUS_TRANSITIONS state machine", () => {
  it("has an entry for every EVENT_VENDOR_STATUS", () => {
    for (const status of EVENT_VENDOR_STATUS_VALUES) {
      expect(VENDOR_STATUS_TRANSITIONS).toHaveProperty(status);
    }
  });

  it("only references valid statuses in transition targets", () => {
    for (const [from, targets] of Object.entries(VENDOR_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(EVENT_VENDOR_STATUS_VALUES).toContain(target);
      }
      // Self-transition not allowed
      expect(targets).not.toContain(from);
    }
  });
});

describe("EVENT_CATEGORIES", () => {
  it("is non-empty and contains 'Other' as a fallback category", () => {
    expect(EVENT_CATEGORIES.length).toBeGreaterThan(0);
    expect(EVENT_CATEGORIES).toContain("Other");
  });

  it("has no duplicates", () => {
    expect(new Set(EVENT_CATEGORIES).size).toBe(EVENT_CATEGORIES.length);
  });
});

describe("OPE-1058 — the shared event-category rule", () => {
  it("keeps on-list values, drops off-list ones, and reports both", () => {
    const { kept, dropped } = partitionEventCategories([
      "Craft Fair",
      "Craft Fsir",
      "Amateur Radio Convention",
    ]);
    expect(kept).toEqual(["Craft Fair", "Amateur Radio Convention"]);
    expect(dropped).toEqual(["Craft Fsir"]);
  });

  it("trims, de-duplicates and ignores empties", () => {
    const { kept, dropped } = partitionEventCategories([" Fair ", "Fair", "", "  "]);
    expect(kept).toEqual(["Fair"]);
    expect(dropped).toEqual([]);
  });

  it("passes the uncategorized placeholder through without calling it a category", () => {
    // "Event" is what a create with nothing usable stores; rejecting it would
    // make such a row un-re-saveable, and adding it to the list would make the
    // admin uncategorized queue meaningless.
    expect(isEventCategory(UNCATEGORIZED_EVENT_CATEGORY)).toBe(false);
    expect(partitionEventCategories(["Event", "Fair"])).toEqual({
      kept: ["Fair"],
      dropped: [],
    });
  });

  it("invalidEventCategories is empty exactly when every value may be stored", () => {
    expect(invalidEventCategories(["Market", "Concert", "Senior Expo"])).toEqual([]);
    expect(invalidEventCategories(["Hamfest"])).toEqual(["Hamfest"]);
    expect(invalidEventCategories(null)).toEqual([]);
  });

  it("carries the ten values John ratified on 2026-09-17", () => {
    for (const added of [
      "Amateur Radio Convention",
      "Concert",
      "Gem & Mineral Show",
      "Hobby Show",
      "Living History",
      "Market",
      "Outdoor Show",
      "Pop Culture Convention",
      "Renaissance Fair",
      "Senior Expo",
    ]) {
      expect(EVENT_CATEGORIES as readonly string[]).toContain(added);
    }
  });

  it("every category page's value is a real category — /events/markets had none", () => {
    // The public category pages serve these six; "Market" was served by
    // /events/markets while being invalid everywhere else.
    for (const served of [
      "Fair",
      "Festival",
      "Craft Show",
      "Craft Fair",
      "Market",
      "Farmers Market",
    ]) {
      expect(isEventCategory(served), served).toBe(true);
    }
  });
});
