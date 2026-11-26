import { describe, it, expect } from "vitest";
import { parseListingPage } from "../listing-page-param";

describe("parseListingPage (OPE-1573)", () => {
  it("absent or empty → page 1", () => {
    expect(parseListingPage(undefined)).toBe(1);
    expect(parseListingPage("")).toBe(1);
  });

  it("plain digits 1–9999 → that page", () => {
    expect(parseListingPage("1")).toBe(1);
    expect(parseListingPage("2")).toBe(2);
    expect(parseListingPage("40")).toBe(40);
    expect(parseListingPage("9999")).toBe(9999);
  });

  // Payloads copied from the 2026-11-13 04:19Z Workers Logs, URL-decoded.
  // parseInt() reads every one of these as 2 or -2.
  it.each([
    "2') AND EXTRACTVALUE(9953,CONCAT(0x7e,((SELECT (ELT(9953=9953,1)))),0x7e))-- -",
    "-2 UNION ALL SELECT NULL,'njoetjfdvobmbycdxqgynebenrqwyscg'-- uvyy8r",
    "2' UNION ALL SELECT 'njoetjfdvobmbycdxqgynebenrqwyscg',NULL-- k2nlor",
    "2%')) AND EXTRACTVALUE(7984,CONCAT(0x7e,((SELECT (ELT(7984=7984,1)))),0x7e))-- -",
  ])("scanner payload %s → null", (raw) => {
    expect(parseListingPage(raw)).toBeNull();
  });

  it.each(["0", "-1", "02", " 2", "2 ", "1.5", "1e3", "abc", "10000", "NaN"])(
    "non-canonical %j → null",
    (raw) => {
      expect(parseListingPage(raw)).toBeNull();
    }
  );

  it("a repeated ?page= key (string[]) → null", () => {
    expect(parseListingPage(["1", "2"])).toBeNull();
  });
});
