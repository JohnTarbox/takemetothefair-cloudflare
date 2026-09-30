/**
 * OPE-405 (09-23 bounce) — the three junk `roster.detected` rows, as fixtures.
 *
 *   614d0dfb (08-28)  PDF metadata: PDFFormatVersion=1.6, Author=…, xmp:*
 *   6687326d (09-03)  form labels: "Your Name", "Commodity/Product Sold",
 *                     "Table Option (bring your own or table needed)"
 *   9fc287ef (09-10)  PDF metadata header over the real master list
 *
 * The two metadata rows predate OPE-943 (#1244, 2026-09-11) — these pin that
 * they cannot recur. The form-label row is new: the fixed label set did not
 * list that wording.
 */
import { describe, it, expect } from "vitest";
import { detectRosterEntries } from "../src/email-handlers/roster-detect.js";

const names = (text: string) => detectRosterEntries(text).map((e) => e.name);

describe("OPE-405 bounce fixtures", () => {
  it("614d0dfb — a PDF's metadata block is never a roster", () => {
    const text = [
      "# Vendors.pdf",
      "## Metadata",
      "- PDFFormatVersion=1.6",
      "- IsLinearized=true",
      "- Author=Tobie, Paige",
      "- Creator=Acrobat PDFMaker 23 for Word",
      "- xmp:createdate=2026-08-01",
      "- xmpmm:documentid=uuid:abc",
      // `xmp:` keys carry a colon, so KEY_VALUE does not catch them — only the
      // metadata strip does. Enough of them to form a 3+ run on their own.
      "- xmp:modifydate=2026-08-02",
      "- xmp:creatortool=Word",
      "- xmpmm:instanceid=uuid:def",
      "## Contents",
      "### Page 1",
      "Thank you for your interest.",
    ].join("\n");
    expect(names(text)).toEqual([]);
  });

  it("6687326d — an application form's fields are never exhibitors", () => {
    const text = [
      "Vendors",
      "- Your Name",
      "- Commodity/Product Sold",
      "- Table Option (bring your own or table needed)",
      "- Your Business",
    ].join("\n");
    expect(names(text)).toEqual([]);
  });

  it("9fc287ef — metadata over a REAL list: the vendors are read, the metadata is not", () => {
    const text = [
      "# Vendorlist.pdf",
      "## Metadata",
      "- PDFFormatVersion=1.7",
      "- Producer=Microsoft: Print To PDF",
      "- Title=masterNGF26.xlsx",
      "## Contents",
      "### Page 1",
      "Vendors",
      "- Granite Ridge Dahlia Co.",
      "- Sebago Woodworks",
      "- Blue Heron Pottery",
      "- Maine Maple Farm",
    ].join("\n");
    const got = names(text);
    expect(got).toEqual([
      "Granite Ridge Dahlia Co.",
      "Sebago Woodworks",
      "Blue Heron Pottery",
      "Maine Maple Farm",
    ]);
    expect(got.some((n) => /=/.test(n))).toBe(false);
  });

  it("the label patterns do not reject real business names", () => {
    const text = [
      "Vendors",
      "- Tableland Farm",
      "- Yourk Candle Co.",
      "- Commonwealth Crafts",
      "- Soldier Pond Soaps",
    ].join("\n");
    expect(names(text)).toHaveLength(4);
  });
});
