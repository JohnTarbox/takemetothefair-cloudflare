import { describe, expect, it } from "vitest";
import { decideVerifyOutcome } from "../decide";

describe("decideVerifyOutcome — page_1_zero_click_queries", () => {
  it("improved when the zero-click query now earns clicks", () => {
    const d = decideVerifyOutcome(
      "page_1_zero_click_queries",
      { clicks: 0, impressions: 40, ctr: 0, position: 6.4 },
      { clicks: 3, impressions: 55, ctr: 0.054, position: 5.1 }
    );
    expect(d.outcome).toBe("improved");
    expect(d.reason).toBe("clicks 0 → 3");
  });

  it("no_movement when clicks are still zero, reason names the position", () => {
    const d = decideVerifyOutcome(
      "page_1_zero_click_queries",
      { clicks: 0, impressions: 40, ctr: 0, position: 6.4 },
      { clicks: 0, impressions: 62, ctr: 0, position: 6.4 }
    );
    expect(d.outcome).toBe("no_movement");
    expect(d.reason).toBe("still 0 clicks (position 6.4)");
  });

  it("is defensive: missing/non-finite after.clicks is treated as zero", () => {
    const d = decideVerifyOutcome("page_1_zero_click_queries", { clicks: 0 }, {
      impressions: 10,
      position: 8,
    } as Record<string, number>);
    expect(d.outcome).toBe("no_movement");
    expect(d.reason).toBe("still 0 clicks (position 8.0)");
  });

  it("unknown rule falls back to no_movement without throwing", () => {
    const d = decideVerifyOutcome("some_other_rule", { clicks: 0 }, { clicks: 5 });
    expect(d.outcome).toBe("no_movement");
    expect(d.reason).toBe("no verifier logic for rule");
  });
});
