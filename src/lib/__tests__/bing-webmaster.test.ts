import { describe, it, expect } from "vitest";
import { parseBingDate, extractRows } from "../bing-webmaster";

describe("parseBingDate", () => {
  it("parses WCF JSON /Date(epochMs)/ format", () => {
    const d = parseBingDate("/Date(1714521600000)/");
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe("2024-05-01T00:00:00.000Z");
  });

  it("parses WCF JSON with negative epoch", () => {
    const d = parseBingDate("/Date(-86400000)/");
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe("1969-12-31T00:00:00.000Z");
  });

  it("parses ISO 8601 strings", () => {
    const d = parseBingDate("2026-04-30T12:34:56Z");
    expect(d?.toISOString()).toBe("2026-04-30T12:34:56.000Z");
  });

  it("parses date-only ISO strings", () => {
    const d = parseBingDate("2026-04-30");
    expect(d?.toISOString().slice(0, 10)).toBe("2026-04-30");
  });

  it("parses raw epoch milliseconds as number", () => {
    const d = parseBingDate(1714521600000);
    expect(d?.toISOString()).toBe("2024-05-01T00:00:00.000Z");
  });

  it("returns null for null and undefined", () => {
    expect(parseBingDate(null)).toBeNull();
    expect(parseBingDate(undefined)).toBeNull();
  });

  it("returns null for unparseable strings rather than throwing", () => {
    expect(parseBingDate("not a date")).toBeNull();
    expect(parseBingDate("Invalid")).toBeNull();
    expect(parseBingDate("")).toBeNull();
  });

  it("returns null for non-string non-number values", () => {
    expect(parseBingDate({})).toBeNull();
    expect(parseBingDate([])).toBeNull();
    expect(parseBingDate(true)).toBeNull();
  });

  it("returns null for NaN and Infinity numbers", () => {
    expect(parseBingDate(NaN)).toBeNull();
    expect(parseBingDate(Infinity)).toBeNull();
  });

  it("does not throw on garbage that previously crashed the integration", () => {
    // The legacy regex would silently produce NaN here, then crash the
    // whole .map() with `RangeError: Invalid time value`. Make sure the
    // helper just returns null instead.
    expect(() => parseBingDate("/Date(notanumber)/")).not.toThrow();
    expect(parseBingDate("/Date(notanumber)/")).toBeNull();
  });
});

describe("extractRows", () => {
  it("returns the array directly when d is an array", () => {
    expect(extractRows<{ a: number }>({ d: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("unwraps OData-style { d: { results: [...] } }", () => {
    expect(extractRows<{ a: number }>({ d: { results: [{ a: 1 }] } })).toEqual([{ a: 1 }]);
  });

  it("unwraps when the first nested value is an array (e.g. GetXxxResult)", () => {
    expect(
      extractRows<{ a: number }>({ d: { GetQueryStatsResult: [{ a: 1 }, { a: 2 }] } })
    ).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("returns [] for { d: null }", () => {
    expect(extractRows({ d: null })).toEqual([]);
  });

  it("returns [] for missing d", () => {
    expect(extractRows({})).toEqual([]);
  });

  it("returns [] for primitives and null inputs", () => {
    expect(extractRows(null)).toEqual([]);
    expect(extractRows(undefined)).toEqual([]);
    expect(extractRows("string")).toEqual([]);
    expect(extractRows(42)).toEqual([]);
  });

  it("returns [] when d is an object with no array values", () => {
    expect(extractRows({ d: { a: 1, b: "x" } })).toEqual([]);
  });
});
