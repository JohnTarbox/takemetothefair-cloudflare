/**
 * OPE-790 rework — which failures degrade. Behavioural, on the shipped
 * predicate, through the same FetchError wrapping the fetchers throw.
 */
import { describe, it, expect } from "vitest";
import { isD1PlatformFault, DEGRADED_METADATA } from "@/lib/db/degraded";
import { FetchError } from "@/lib/errors/fetch-error";

const wrap = (msg: string) =>
  new FetchError("app/vendors/[slug]/page.tsx:getVendor", new Error(msg));

describe("isD1PlatformFault", () => {
  it.each([
    "D1_ERROR: Network connection lost.", // the 12 vendor-detail failures, 09-24 → 10-04
    "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
    "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
  ])("degrades on a platform blip wrapped in FetchError: %s", (msg) => {
    expect(isD1PlatformFault(wrap(msg))).toBe(true);
  });

  it.each([
    "D1_ERROR: no such column: foo: SQLITE_ERROR",
    "D1_ERROR: too many SQL variables",
    "TypeError: Cannot read properties of undefined",
  ])("does NOT degrade on our own defect: %s", (msg) => {
    expect(isD1PlatformFault(wrap(msg))).toBe(false);
  });

  it("the degraded metadata is noindex", () => {
    expect(DEGRADED_METADATA.robots).toEqual({ index: false, follow: false });
  });
});
