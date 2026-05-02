import { describe, it, expect } from "vitest";
import {
  isPublicVendorStatus,
  isValidTransition,
  VALID_TRANSITIONS,
  STATUS_LABELS,
  STATUS_BADGE_VARIANTS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_BADGE_VARIANTS,
} from "../vendor-status";
import { isPublicEventStatus, isTentativeEvent } from "../event-status";
import {
  EVENT_VENDOR_STATUS,
  EVENT_VENDOR_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
} from "@/lib/constants";

// State-machine helpers in event-status.ts and vendor-status.ts drive
// every admin lifecycle decision. These are pure functions — the value
// of the tests is in nailing down the transition matrix and ensuring
// every enum value is mapped (so adding a new status to constants.ts
// without updating these tables fails CI loudly instead of silently
// rendering as "undefined" in the admin UI).

describe("isPublicEventStatus / isPublicVendorStatus / isTentativeEvent", () => {
  it("isPublicEventStatus returns a Drizzle clause without throwing", () => {
    // We can't usefully introspect the clause (Drizzle's SQL-builder
    // objects are opaque + circular), but we can confirm it constructs
    // and is non-null — the integration is covered by /events page tests.
    const clause = isPublicEventStatus();
    expect(clause).toBeDefined();
  });

  it("isPublicVendorStatus returns a Drizzle clause without throwing", () => {
    const clause = isPublicVendorStatus();
    expect(clause).toBeDefined();
  });

  it("isTentativeEvent returns true only for the literal 'TENTATIVE'", () => {
    expect(isTentativeEvent("TENTATIVE")).toBe(true);
    expect(isTentativeEvent("APPROVED")).toBe(false);
    expect(isTentativeEvent("DRAFT")).toBe(false);
    expect(isTentativeEvent("")).toBe(false);
    // Case-sensitive on purpose: DB stores upper-case literals.
    expect(isTentativeEvent("tentative")).toBe(false);
  });
});

describe("VALID_TRANSITIONS matrix", () => {
  it("has an entry for every event-vendor status", () => {
    // Catches the silent-bug case where someone adds a new status to
    // EVENT_VENDOR_STATUS without extending the transition matrix —
    // every UI dropdown would show that status as "no transitions
    // available", which is wrong but visually plausible.
    for (const status of EVENT_VENDOR_STATUS_VALUES) {
      expect(VALID_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("only points at known statuses (no orphan transitions)", () => {
    const validValues = new Set(EVENT_VENDOR_STATUS_VALUES);
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        expect(validValues.has(to)).toBe(true);
      }
      expect(validValues.has(from as (typeof EVENT_VENDOR_STATUS_VALUES)[number])).toBe(true);
    }
  });
});

describe("isValidTransition", () => {
  it("allows the documented happy-path lifecycle", () => {
    // Vendor flow: INVITED → APPLIED → APPROVED → CONFIRMED
    expect(isValidTransition(EVENT_VENDOR_STATUS.INVITED, EVENT_VENDOR_STATUS.APPLIED)).toBe(true);
    expect(isValidTransition(EVENT_VENDOR_STATUS.APPLIED, EVENT_VENDOR_STATUS.APPROVED)).toBe(true);
    expect(isValidTransition(EVENT_VENDOR_STATUS.APPROVED, EVENT_VENDOR_STATUS.CONFIRMED)).toBe(
      true
    );
  });

  it("allows the alternative APPLIED → CONFIRMED shortcut for self-confirm vendors", () => {
    expect(isValidTransition(EVENT_VENDOR_STATUS.APPLIED, EVENT_VENDOR_STATUS.CONFIRMED)).toBe(
      true
    );
  });

  it("allows recovery from REJECTED back to APPLIED or INVITED", () => {
    expect(isValidTransition(EVENT_VENDOR_STATUS.REJECTED, EVENT_VENDOR_STATUS.APPLIED)).toBe(true);
    expect(isValidTransition(EVENT_VENDOR_STATUS.REJECTED, EVENT_VENDOR_STATUS.INVITED)).toBe(true);
  });

  it("denies skipping forward (CONFIRMED cannot go back to APPLIED)", () => {
    expect(isValidTransition(EVENT_VENDOR_STATUS.CONFIRMED, EVENT_VENDOR_STATUS.APPLIED)).toBe(
      false
    );
  });

  it("denies CANCELLED → APPROVED / CONFIRMED (terminal except via re-invite)", () => {
    expect(isValidTransition(EVENT_VENDOR_STATUS.CANCELLED, EVENT_VENDOR_STATUS.APPROVED)).toBe(
      false
    );
    expect(isValidTransition(EVENT_VENDOR_STATUS.CANCELLED, EVENT_VENDOR_STATUS.CONFIRMED)).toBe(
      false
    );
    // Re-invite is the only allowed exit from CANCELLED.
    expect(isValidTransition(EVENT_VENDOR_STATUS.CANCELLED, EVENT_VENDOR_STATUS.INVITED)).toBe(
      true
    );
  });

  it("denies WITHDRAWN → APPROVED (vendor can re-engage but not jump straight to approved)", () => {
    expect(isValidTransition(EVENT_VENDOR_STATUS.WITHDRAWN, EVENT_VENDOR_STATUS.APPROVED)).toBe(
      false
    );
    expect(isValidTransition(EVENT_VENDOR_STATUS.WITHDRAWN, EVENT_VENDOR_STATUS.APPLIED)).toBe(
      true
    );
  });

  it("returns false for unknown source statuses", () => {
    expect(isValidTransition("BOGUS", EVENT_VENDOR_STATUS.APPLIED)).toBe(false);
    expect(isValidTransition("", "")).toBe(false);
  });

  it("returns false for unknown target statuses from a known source", () => {
    expect(isValidTransition(EVENT_VENDOR_STATUS.APPLIED, "BOGUS")).toBe(false);
  });

  it("denies the no-op transition (a→a) consistently", () => {
    // Loop over every status — none should be allowed to "transition" to itself.
    for (const status of EVENT_VENDOR_STATUS_VALUES) {
      expect(isValidTransition(status, status)).toBe(false);
    }
  });
});

describe("display tables completeness", () => {
  it("STATUS_LABELS has a label for every status", () => {
    for (const status of EVENT_VENDOR_STATUS_VALUES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("STATUS_BADGE_VARIANTS has a variant for every status", () => {
    for (const status of EVENT_VENDOR_STATUS_VALUES) {
      expect(STATUS_BADGE_VARIANTS[status]).toBeTruthy();
    }
  });

  it("PAYMENT_STATUS_LABELS has a label for every payment status", () => {
    for (const status of PAYMENT_STATUS_VALUES) {
      expect(PAYMENT_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("PAYMENT_STATUS_BADGE_VARIANTS has a variant for every payment status", () => {
    for (const status of PAYMENT_STATUS_VALUES) {
      expect(PAYMENT_STATUS_BADGE_VARIANTS[status]).toBeTruthy();
    }
  });

  it("APPROVED and CONFIRMED both render as 'success' (parity expected by admin UI)", () => {
    expect(STATUS_BADGE_VARIANTS[EVENT_VENDOR_STATUS.APPROVED]).toBe("success");
    expect(STATUS_BADGE_VARIANTS[EVENT_VENDOR_STATUS.CONFIRMED]).toBe("success");
  });

  it("PAID renders as 'success' and OVERDUE renders as 'danger'", () => {
    expect(PAYMENT_STATUS_BADGE_VARIANTS[PAYMENT_STATUS.PAID]).toBe("success");
    expect(PAYMENT_STATUS_BADGE_VARIANTS[PAYMENT_STATUS.OVERDUE]).toBe("danger");
  });
});
