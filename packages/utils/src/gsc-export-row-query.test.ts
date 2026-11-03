import { describe, expect, it } from "vitest";
import { isGscExportRowQuery } from "./gsc-export-row-query";

describe("isGscExportRowQuery (OPE-1255)", () => {
  it.each([
    "craft fairs on cape cod this weekend,410,3051,13.44%,3.16",
    "sandwich fest street fair,57,163,34.97%,2",
    "cape cod fairs 2025,82,640,12.81%,4.5",
  ])("flags the export row %j", (q) => expect(isGscExportRowQuery(q)).toBe(true));

  it.each([
    "fairs in bangor, me",
    "craft fairs, maine, 2026",
    "fryeburg fair 2026",
    "event 10,000 visitors",
    "",
  ])("leaves the real query %j alone", (q) => expect(isGscExportRowQuery(q)).toBe(false));
});
