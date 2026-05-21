/**
 * Tests for the correction handler's name-resolution tiers (spec §C.9).
 * Pure-function tests on extractEventSlug (Tier 1) and pickNameCandidate
 * (Tier 2 input). The full Tier-2 fuzzy match path requires a D1 instance
 * to query events.name + admin_actions and is exercised via integration
 * tests in PR-D2's deploy-verification checklist rather than here.
 */
import { describe, expect, it } from "vitest";
import { extractEventSlug, pickNameCandidate } from "../src/email-handlers/correction.js";

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

describe("pickNameCandidate — subject preferred over body", () => {
  it("uses raw subject when reasonable", () => {
    expect(pickNameCandidate("Boxboro Hamfest", "wrong date\nplease fix")).toBe("Boxboro Hamfest");
  });

  it("strips a single Re: prefix", () => {
    expect(pickNameCandidate("Re: Chester Greenwood Day", null)).toBe("Chester Greenwood Day");
  });

  it("strips stacked Re: Fwd: prefixes", () => {
    expect(pickNameCandidate("Re: Fwd: Re: Nutmeg Hamfest", null)).toBe("Nutmeg Hamfest");
  });

  it("falls back to body when subject is a generic correction word", () => {
    // Subjects like "wrong" or "correction" carry no event-name signal.
    expect(pickNameCandidate("wrong", "Blue Hill Fair is on the wrong date")).toBe(
      "Blue Hill Fair is on the wrong date"
    );
  });

  it("falls back to body when subject is too short", () => {
    expect(pickNameCandidate("Re:", "Garden Craft Fair date is incorrect")).toBe(
      "Garden Craft Fair date is incorrect"
    );
  });

  it("returns null when neither subject nor body has anything usable", () => {
    expect(pickNameCandidate(null, null)).toBeNull();
    expect(pickNameCandidate("", "")).toBeNull();
    expect(pickNameCandidate("Re:", "   ")).toBeNull();
  });

  it("caps body fallback at 100 chars", () => {
    const longBody = "A".repeat(150);
    const result = pickNameCandidate(null, longBody);
    expect(result?.length).toBe(100);
  });

  it("skips body lines shorter than 3 chars when picking the first usable", () => {
    expect(pickNameCandidate("Re:", "x\n\n\nthe real event name here")).toBe(
      "the real event name here"
    );
  });
});
