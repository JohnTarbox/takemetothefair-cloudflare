/**
 * Unit tests for the TAX1 Phase 3 audience-badge helper.
 *
 * The 6-scenario table from A2 of the dev email is the source of
 * truth; one test per row plus edge cases for missing values + the
 * MEMBERS+OPEN access_notes path.
 */

import { describe, it, expect } from "vitest";
import { formatAudienceBadge, isClosedToPublic, hasNonDefaultAudience } from "../event-audience";

describe("formatAudienceBadge — 6-scenario table", () => {
  it("PUBLIC + OPEN → no badge (the default, ~95% of events)", () => {
    expect(formatAudienceBadge("PUBLIC", "OPEN")).toBe(null);
  });

  it("PUBLIC + CLOSED → 'Not currently open to attendees'", () => {
    const badge = formatAudienceBadge("PUBLIC", "CLOSED");
    expect(badge?.label).toBe("Not currently open to attendees");
    expect(badge?.variant).toBe("warning");
    expect(badge?.key).toBe("public_closed");
  });

  it("TRADE + CLOSED → 'Trade only — not open to the public'", () => {
    const badge = formatAudienceBadge("TRADE", "CLOSED");
    expect(badge?.label).toBe("Trade only — not open to the public");
    expect(badge?.variant).toBe("info");
    expect(badge?.key).toBe("trade_closed");
  });

  it("TRADE + OPEN → 'Industry trade show — public welcome'", () => {
    const badge = formatAudienceBadge("TRADE", "OPEN");
    expect(badge?.label).toBe("Industry trade show — public welcome");
    expect(badge?.variant).toBe("info");
    expect(badge?.key).toBe("trade_open_paid");
  });

  it("MEMBERS + CLOSED → 'Members only'", () => {
    const badge = formatAudienceBadge("MEMBERS", "CLOSED");
    expect(badge?.label).toBe("Members only");
    expect(badge?.variant).toBe("default");
    expect(badge?.key).toBe("members_closed");
  });

  it("MEMBERS + OPEN (no notes) → generic public-welcome label", () => {
    const badge = formatAudienceBadge("MEMBERS", "OPEN");
    expect(badge?.label).toBe("Members event — public welcome");
    expect(badge?.variant).toBe("info");
    expect(badge?.key).toBe("members_open");
  });

  it("MEMBERS + OPEN + short notes → notes appended to label", () => {
    const badge = formatAudienceBadge("MEMBERS", "OPEN", "plant sale Sat 9am-1pm");
    expect(badge?.label).toBe("Members event — public welcome — plant sale Sat 9am-1pm");
  });

  it("MEMBERS + OPEN + long notes → notes NOT appended (kept for description)", () => {
    const longNotes =
      "Annual members' convention with a wide variety of public-facing activities throughout the weekend including a plant sale and craft show.";
    const badge = formatAudienceBadge("MEMBERS", "OPEN", longNotes);
    expect(badge?.label).toBe("Members event — public welcome");
  });
});

describe("formatAudienceBadge — missing values fall back to permissive default", () => {
  it("null primaryAudience treated as PUBLIC", () => {
    expect(formatAudienceBadge(null, "OPEN")).toBe(null);
    expect(formatAudienceBadge(undefined, "OPEN")).toBe(null);
  });

  it("null publicAccess treated as OPEN", () => {
    expect(formatAudienceBadge("PUBLIC", null)).toBe(null);
    expect(formatAudienceBadge("PUBLIC", undefined)).toBe(null);
  });

  it("both null → no badge", () => {
    expect(formatAudienceBadge(null, null)).toBe(null);
  });

  it("MEMBERS + null access defaults to OPEN", () => {
    const badge = formatAudienceBadge("MEMBERS", null);
    expect(badge?.label).toBe("Members event — public welcome");
  });
});

describe("isClosedToPublic", () => {
  it("CLOSED → true", () => {
    expect(isClosedToPublic("CLOSED")).toBe(true);
  });

  it("OPEN → false", () => {
    expect(isClosedToPublic("OPEN")).toBe(false);
  });

  it("null/undefined → false (default OPEN)", () => {
    expect(isClosedToPublic(null)).toBe(false);
    expect(isClosedToPublic(undefined)).toBe(false);
  });
});

describe("hasNonDefaultAudience", () => {
  it("PUBLIC + OPEN → false (default)", () => {
    expect(hasNonDefaultAudience("PUBLIC", "OPEN")).toBe(false);
  });

  it("TRADE + OPEN → true (non-default audience)", () => {
    expect(hasNonDefaultAudience("TRADE", "OPEN")).toBe(true);
  });

  it("PUBLIC + CLOSED → true (non-default access)", () => {
    expect(hasNonDefaultAudience("PUBLIC", "CLOSED")).toBe(true);
  });

  it("MEMBERS + CLOSED → true (both non-default)", () => {
    expect(hasNonDefaultAudience("MEMBERS", "CLOSED")).toBe(true);
  });

  it("null/undefined fall back to default", () => {
    expect(hasNonDefaultAudience(null, null)).toBe(false);
    expect(hasNonDefaultAudience(undefined, undefined)).toBe(false);
  });
});
