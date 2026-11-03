/**
 * OPE-794 — summarising an event's per-lane capacity for a surface that shows
 * the event once. Best lane wins; an unknown future status is never an
 * invitation (allow-list, like isOpenToVendorApplications).
 */
import { describe, it, expect } from "vitest";
import { summarizeLaneCapacity } from "./index";

describe("summarizeLaneCapacity", () => {
  it.each([
    [[], "UNKNOWN"],
    [["OPEN"], "OPEN"],
    [["FULL", "OPEN"], "OPEN"],
    [["WAITLIST", "UNKNOWN"], "UNKNOWN"],
    [[null], "UNKNOWN"],
    [["WAITLIST"], "WAITLIST"],
    [["WAITLIST", "FULL"], "WAITLIST"],
    [["FULL"], "UNAVAILABLE"],
    [["FULL", "CLOSED"], "UNAVAILABLE"],
    [["SOME_FUTURE_STATUS"], "UNAVAILABLE"],
  ] as const)("%j → %s", (lanes, want) => {
    expect(summarizeLaneCapacity(lanes as unknown as string[])).toBe(want);
  });
});
