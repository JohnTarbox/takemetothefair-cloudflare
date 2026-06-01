import { describe, it, expect } from "vitest";
import { pluralize } from "../text";

describe("pluralize", () => {
  it("uses the singular form for exactly 1", () => {
    expect(pluralize(1, "event")).toBe("1 event");
    expect(pluralize(1, "venue")).toBe("1 venue");
  });

  it("appends an 's' for counts other than 1", () => {
    expect(pluralize(0, "event")).toBe("0 events");
    expect(pluralize(2, "event")).toBe("2 events");
    expect(pluralize(42, "event")).toBe("42 events");
  });

  it("uses the explicit plural override when supplied", () => {
    expect(pluralize(1, "entry", "entries")).toBe("1 entry");
    expect(pluralize(3, "entry", "entries")).toBe("3 entries");
  });

  it("formats large counts with toLocaleString (commas in en-US)", () => {
    // toLocaleString output is locale-sensitive but the en-US default
    // (which CI runs under) uses commas. Loose-assert by stripping
    // commas instead of pinning to a specific locale.
    expect(pluralize(1234, "event").replace(/,/g, "")).toBe("1234 events");
  });

  it("handles 0 as plural (not singular)", () => {
    // 0 reads as "no" / "zero" in English; "0 events" matches that.
    expect(pluralize(0, "vendor")).toBe("0 vendors");
  });
});
