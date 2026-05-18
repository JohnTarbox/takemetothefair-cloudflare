import { describe, expect, it } from "vitest";
import { normalizeEventDate } from "../event-dates";

describe("normalizeEventDate — submit-time noon-UTC normalization", () => {
  it("appends noon UTC to bare YYYY-MM-DD strings", () => {
    expect(normalizeEventDate("2026-10-02")?.toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  it("normalizes explicit midnight UTC to noon UTC", () => {
    expect(normalizeEventDate("2026-10-02T00:00:00Z")?.toISOString()).toBe(
      "2026-10-02T12:00:00.000Z"
    );
    expect(normalizeEventDate("2026-10-02T00:00:00.000Z")?.toISOString()).toBe(
      "2026-10-02T12:00:00.000Z"
    );
    expect(normalizeEventDate("2026-10-02T00:00:00")?.toISOString()).toBe(
      "2026-10-02T12:00:00.000Z"
    );
  });

  it("preserves real (non-midnight) times as-is", () => {
    expect(normalizeEventDate("2026-10-02T14:30:00Z")?.toISOString()).toBe(
      "2026-10-02T14:30:00.000Z"
    );
  });

  it("returns null for null/empty/whitespace input", () => {
    expect(normalizeEventDate(null)).toBeNull();
    expect(normalizeEventDate(undefined)).toBeNull();
    expect(normalizeEventDate("")).toBeNull();
    expect(normalizeEventDate("   ")).toBeNull();
  });

  it("returns null for unparseable date strings", () => {
    expect(normalizeEventDate("not-a-date")).toBeNull();
    expect(normalizeEventDate("2026-13-99")).toBeNull();
  });

  it("real-world NEAR-Fest case: bare 2026-10-02 lands as Oct 2 in EDT, not Oct 1", () => {
    const d = normalizeEventDate("2026-10-02");
    const inEDT = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d!);
    expect(inEDT).toBe("10/02/2026");
  });
});
