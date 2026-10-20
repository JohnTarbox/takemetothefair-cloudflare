import { describe, expect, it } from "vitest";
import {
  VENDOR_CAPACITY_OPEN_TO_APPLICATIONS,
  VENDOR_CAPACITY_STATUSES,
} from "@takemetothefair/constants";
import {
  isVendorCallCurrent,
  normalizeVendorCategories,
  parseVendorCategories,
  serializeVendorCategories,
} from "./vendor-call";

describe("OPE-1512 vendor call helpers", () => {
  it("normalizes: trims, decodes, collapses whitespace, dedupes case-insensitively, keeps order", () => {
    expect(
      normalizeVendorCategories([
        "  Pottery ",
        "Wood   working",
        "pottery",
        "",
        "Soap &amp; Candles",
      ])
    ).toEqual(["Pottery", "Wood working", "Soap & Candles"]);
  });

  it("refuses rather than truncates", () => {
    expect(() => normalizeVendorCategories(["x".repeat(61)])).toThrow(/max 60/);
    expect(() => normalizeVendorCategories(Array.from({ length: 26 }, (_, i) => `c${i}`))).toThrow(
      /max 25/
    );
  });

  it("stores [] as NULL and reads anything malformed as []", () => {
    expect(serializeVendorCategories([])).toBeNull();
    expect(parseVendorCategories(serializeVendorCategories(["A", "B"]))).toEqual(["A", "B"]);
    for (const bad of [null, "", "not json", '{"a":1}', '[1, "ok"]']) {
      expect(parseVendorCategories(bad)).toEqual(bad === '[1, "ok"]' ? ["ok"] : []);
    }
  });

  it("is current only when OPEN — parity with VENDOR_CAPACITY_OPEN_TO_APPLICATIONS", () => {
    const now = new Date("2026-10-20T16:00:00Z");
    const current = VENDOR_CAPACITY_STATUSES.filter((s) =>
      isVendorCallCurrent({ capacityStatus: s, closesAt: null }, now)
    );
    expect(current).toEqual([...VENDOR_CAPACITY_OPEN_TO_APPLICATIONS]);
  });

  it("a deadline closes the call only once its calendar day has passed in the venue zone", () => {
    const now = new Date("2026-10-21T02:00:00Z"); // Oct 20, 22:00 ET
    const open = (closesAt: string) =>
      isVendorCallCurrent({ capacityStatus: "OPEN", closesAt: new Date(closesAt) }, now);
    expect(open("2026-10-21T03:59:59Z")).toBe(true); // closes Oct 20 ET — today
    expect(open("2026-10-20T12:00:00Z")).toBe(true); // noon-UTC anchor, same day: not early
    expect(open("2026-10-20T03:59:59Z")).toBe(false); // closed Oct 19 ET
  });
});
