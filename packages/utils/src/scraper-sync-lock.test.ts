import { describe, expect, it } from "vitest";
import { changedScraperSyncedFields, shouldDisableScraperSync } from "./scraper-sync-lock";

const current = {
  name: "Harvest Fair",
  description: "Old",
  startDate: new Date("2026-09-12T12:00:00Z"),
  endDate: new Date("2026-09-13T12:00:00Z"),
  imageUrl: null,
  ticketUrl: "https://a.example",
  venueId: "v1",
};

describe("OPE-1393 changedScraperSyncedFields", () => {
  it("names only synced fields whose value changes", () => {
    expect(
      changedScraperSyncedFields(current, {
        description: "New",
        venueId: "v1",
        tags: "[]",
        updatedAt: new Date(),
      })
    ).toEqual(["description"]);
  });

  it("a full-form resave of unchanged values is not an edit", () => {
    expect(
      changedScraperSyncedFields(current, {
        ...current,
        imageUrl: "", // form posts "" for an empty field
        startDate: new Date("2026-09-12T00:00:00Z"), // legacy midnight anchor, same day
      })
    ).toEqual([]);
  });

  it("detects a date moved by a day, a cleared venue, and a new image", () => {
    expect(
      changedScraperSyncedFields(current, {
        startDate: "2026-09-13T12:00:00Z",
        venueId: null,
        imageUrl: "https://img.example/x.jpg",
      })
    ).toEqual(["startDate", "imageUrl", "venueId"]);
  });

  it("ignores keys set to undefined", () => {
    expect(changedScraperSyncedFields(current, { name: undefined })).toEqual([]);
  });
});

describe("OPE-1393 shouldDisableScraperSync", () => {
  it("disables when a synced field changed on a synced row with no explicit intent", () => {
    expect(
      shouldDisableScraperSync({
        currentSyncEnabled: true,
        explicitSyncEnabled: undefined,
        changedFields: ["description"],
      })
    ).toBe(true);
  });
  it("an explicit sync_enabled wins", () => {
    expect(
      shouldDisableScraperSync({
        currentSyncEnabled: true,
        explicitSyncEnabled: true,
        changedFields: ["description"],
      })
    ).toBe(false);
  });
  it("nothing to do when sync is already off or nothing synced changed", () => {
    expect(
      shouldDisableScraperSync({
        currentSyncEnabled: false,
        explicitSyncEnabled: undefined,
        changedFields: ["description"],
      })
    ).toBe(false);
    expect(
      shouldDisableScraperSync({
        currentSyncEnabled: true,
        explicitSyncEnabled: undefined,
        changedFields: [],
      })
    ).toBe(false);
  });
});
