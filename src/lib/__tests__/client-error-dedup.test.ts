import { describe, it, expect } from "vitest";
import { createDeduper } from "../client-error-dedup";

const WINDOW = 5_000;

describe("createDeduper", () => {
  it("reports the first occurrence of a key", () => {
    const d = createDeduper(WINDOW);
    expect(d.isDuplicate("a", 0)).toBe(false);
  });

  it("suppresses the same key reported again within the window", () => {
    const d = createDeduper(WINDOW);
    expect(d.isDuplicate("a", 0)).toBe(false); // reported
    expect(d.isDuplicate("a", 4_000)).toBe(true); // within 5s → duplicate
    expect(d.isDuplicate("a", 5_000)).toBe(true); // exactly at window edge → still duplicate
  });

  it("reports again once the window has fully elapsed since the last REPORT (not last hit)", () => {
    const d = createDeduper(WINDOW);
    expect(d.isDuplicate("a", 0)).toBe(false); // reported at 0
    expect(d.isDuplicate("a", 4_000)).toBe(true); // suppressed; does NOT refresh the 0 timestamp
    // 6000 - 0 = 6000 > 5000 → window elapsed since the report at 0 → report again
    expect(d.isDuplicate("a", 6_000)).toBe(false);
    // ...and that re-report resets the clock
    expect(d.isDuplicate("a", 9_000)).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const d = createDeduper(WINDOW);
    expect(d.isDuplicate("a", 0)).toBe(false);
    expect(d.isDuplicate("b", 100)).toBe(false); // different key, not a duplicate
    expect(d.isDuplicate("a", 200)).toBe(true); // 'a' still within window
    expect(d.isDuplicate("b", 200)).toBe(true); // 'b' still within window
  });

  it("does not leak: an expired key is pruned and treated as fresh", () => {
    const d = createDeduper(WINDOW);
    expect(d.isDuplicate("a", 0)).toBe(false);
    // Far in the future, 'a' is expired → pruned → fresh report, not a duplicate.
    expect(d.isDuplicate("a", 100_000)).toBe(false);
  });
});
