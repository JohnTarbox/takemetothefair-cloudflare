/**
 * Tests for the correction handler's slug-extraction (C.9 tier 1).
 * Pure-function tests on the exported extractEventSlug helper.
 */
import { describe, expect, it } from "vitest";
import { extractEventSlug } from "../src/email-handlers/correction.js";

describe("extractEventSlug — happy path", () => {
  it("plain URL", () => {
    expect(extractEventSlug("https://meetmeatthefair.com/events/near-fest-xxxix")).toBe(
      "near-fest-xxxix"
    );
  });
  it("www prefix", () => {
    expect(extractEventSlug("https://www.meetmeatthefair.com/events/blue-hill-fair")).toBe(
      "blue-hill-fair"
    );
  });
  it("uppercase scheme + host", () => {
    expect(extractEventSlug("HTTPS://www.meetmeatthefair.com/events/Lilac-Festival")).toBe(
      "lilac-festival"
    );
  });
  it("URL embedded in prose", () => {
    expect(
      extractEventSlug("The date on https://meetmeatthefair.com/events/garden-craft-fair is wrong.")
    ).toBe("garden-craft-fair");
  });
  it("URL with trailing punctuation", () => {
    expect(extractEventSlug("see https://meetmeatthefair.com/events/event-x.")).toBe("event-x");
  });
});

describe("extractEventSlug — no match", () => {
  it("returns null for non-MMATF URL", () => {
    expect(extractEventSlug("https://example.com/events/foo")).toBeNull();
  });
  it("returns null for MMATF URL without /events/", () => {
    expect(extractEventSlug("https://meetmeatthefair.com/about")).toBeNull();
  });
  it("returns null for plain text", () => {
    expect(extractEventSlug("the lilac festival date is wrong")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(extractEventSlug("")).toBeNull();
  });
});
