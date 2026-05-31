/**
 * Tests for normalizeName in the /api/suggest-event/check-duplicate route.
 *
 * Locks in the K2 (analyst, 2026-05-31) ordinal / Annual / trailing-year
 * stripping rules. The canonical Winthrop case is the headline assertion:
 * "38th Annual Winthrop Arts Festival" and "Winthrop Arts Festival 2026"
 * MUST normalize to the same string so the Levenshtein-similarity
 * tiebreaker accepts them as a match instead of creating PENDING
 * duplicate 25ef60f0 alongside APPROVED 4ee1de4a.
 *
 * Full route-level integration is covered by the email pipeline tests in
 * mcp-server/__tests__/email-handlers-submit.test.ts — they exercise the
 * same /check-duplicate endpoint end-to-end including the venue_date and
 * city_state_date branches that this file doesn't cover.
 */

import { describe, it, expect } from "vitest";
import { normalizeName } from "../normalize-name";

describe("normalizeName — K2 canonical Winthrop case", () => {
  it("collapses '38th Annual Winthrop Arts Festival' and 'Winthrop Arts Festival 2026' to the same string", () => {
    const a = normalizeName("38th Annual Winthrop Arts Festival");
    const b = normalizeName("Winthrop Arts Festival 2026");
    expect(a).toBe("winthrop arts festival");
    expect(b).toBe("winthrop arts festival");
    expect(a).toBe(b);
  });
});

describe("normalizeName — leading ordinal stripping", () => {
  it.each([
    ["1st Annual Foo Fair", "foo fair"],
    ["2nd Annual Foo Fair", "foo fair"],
    ["3rd Annual Foo Fair", "foo fair"],
    ["100th Annual Foo Fair", "foo fair"],
    ["38th Winthrop Arts Festival", "winthrop arts festival"],
  ])("strips '%s' to '%s'", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("does NOT strip an ordinal mid-string (only leading)", () => {
    // "Run for the 50th anniversary" — the 50th is in the middle, not a
    // year-count prefix. We're conservative: leading-only.
    expect(normalizeName("Run for the 50th anniversary")).toBe("run for the 50th anniversary");
  });
});

describe("normalizeName — 'Annual' stripping", () => {
  it("strips a leading 'Annual'", () => {
    expect(normalizeName("Annual Foo Fair")).toBe("foo fair");
  });

  it("is case-insensitive on 'Annual'", () => {
    expect(normalizeName("ANNUAL Foo Fair")).toBe("foo fair");
  });

  it("does NOT strip 'annual' mid-string", () => {
    expect(normalizeName("The Annual Report Show")).toBe("the annual report show");
  });
});

describe("normalizeName — trailing year stripping", () => {
  it.each([
    ["Foo Fair 2026", "foo fair"],
    ["Foo Fair 1999", "foo fair"],
    ["Foo Fair 2100", "foo fair"],
  ])("strips trailing year from '%s'", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("does NOT strip a leading year", () => {
    expect(normalizeName("2026 Foo Fair")).toBe("2026 foo fair");
  });

  it("does NOT strip a mid-string year", () => {
    expect(normalizeName("The 2026 Lottery Drawing")).toBe("the 2026 lottery drawing");
  });
});

describe("normalizeName — existing behaviors preserved", () => {
  it("strips punctuation and collapses the resulting whitespace", () => {
    // "&" between spaces leaves a double space after stripping, which the
    // /\s+/g collapse then folds back to a single space. Lock in the
    // final shape — apostrophe drops without leaving a gap.
    expect(normalizeName("Foo's Fair & Festival!")).toBe("foos fair festival");
  });

  it("collapses whitespace", () => {
    expect(normalizeName("Foo    Fair   ")).toBe("foo fair");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });
});
