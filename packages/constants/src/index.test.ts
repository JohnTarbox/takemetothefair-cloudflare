import { describe, it, expect } from "vitest";
import {
  EVENT_STATUS,
  EVENT_STATUS_VALUES,
  PUBLIC_EVENT_STATUSES,
  EVENT_VENDOR_STATUS,
  EVENT_VENDOR_STATUS_VALUES,
  PUBLIC_VENDOR_STATUSES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  VENDOR_STATUS_TRANSITIONS,
  EVENT_CATEGORIES,
} from "./index";

describe("status enum shape", () => {
  it("EVENT_STATUS_VALUES has every key from EVENT_STATUS", () => {
    expect(EVENT_STATUS_VALUES.length).toBe(Object.keys(EVENT_STATUS).length);
    for (const v of Object.values(EVENT_STATUS)) {
      expect(EVENT_STATUS_VALUES).toContain(v);
    }
  });

  it("EVENT_VENDOR_STATUS_VALUES has every key from EVENT_VENDOR_STATUS", () => {
    expect(EVENT_VENDOR_STATUS_VALUES.length).toBe(Object.keys(EVENT_VENDOR_STATUS).length);
  });

  it("PAYMENT_STATUS_VALUES has every key from PAYMENT_STATUS", () => {
    expect(PAYMENT_STATUS_VALUES.length).toBe(Object.keys(PAYMENT_STATUS).length);
  });

  it("PUBLIC_EVENT_STATUSES is a subset of EVENT_STATUS_VALUES", () => {
    for (const s of PUBLIC_EVENT_STATUSES) {
      expect(EVENT_STATUS_VALUES).toContain(s);
    }
  });

  it("PUBLIC_VENDOR_STATUSES is a subset of EVENT_VENDOR_STATUS_VALUES", () => {
    for (const s of PUBLIC_VENDOR_STATUSES) {
      expect(EVENT_VENDOR_STATUS_VALUES).toContain(s);
    }
  });
});

describe("VENDOR_STATUS_TRANSITIONS state machine", () => {
  it("has an entry for every EVENT_VENDOR_STATUS", () => {
    for (const status of EVENT_VENDOR_STATUS_VALUES) {
      expect(VENDOR_STATUS_TRANSITIONS).toHaveProperty(status);
    }
  });

  it("only references valid statuses in transition targets", () => {
    for (const [from, targets] of Object.entries(VENDOR_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(EVENT_VENDOR_STATUS_VALUES).toContain(target);
      }
      // Self-transition not allowed
      expect(targets).not.toContain(from);
    }
  });
});

describe("EVENT_CATEGORIES", () => {
  it("is non-empty and contains 'Other' as a fallback category", () => {
    expect(EVENT_CATEGORIES.length).toBeGreaterThan(0);
    expect(EVENT_CATEGORIES).toContain("Other");
  });

  it("has no duplicates", () => {
    expect(new Set(EVENT_CATEGORIES).size).toBe(EVENT_CATEGORIES.length);
  });
});
