/**
 * Vendor status helpers — centralizes display, transitions, and query logic
 * for the eventVendors application lifecycle.
 */

import { and, inArray } from "drizzle-orm";
import { eventVendors } from "@/lib/db/schema";
import { vendorLinkIsPublicallyVisible } from "@takemetothefair/db-schema";
import {
  EVENT_VENDOR_STATUS,
  PUBLIC_VENDOR_STATUSES,
  PAYMENT_STATUS,
  type EventVendorStatus,
  type PaymentStatus,
} from "@/lib/constants";

// ---------------------------------------------------------------------------
// Public-visibility filter (Drizzle WHERE clause)
// ---------------------------------------------------------------------------

/** Drizzle WHERE clause: status IN (APPROVED, CONFIRMED) */
export function isPublicVendorStatus() {
  return inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]);
}

/**
 * OPE-316 — the PUBLIC boundary for an event↔vendor link.
 *
 * Two independent questions, deliberately kept separate:
 *   - isPublicVendorStatus() — is the link in a workflow state we'd ever show?
 *   - publicVisible          — did this particular vendor ask to be hidden?
 *
 * A public surface needs BOTH. Admin roster views, coverage stats and analytics
 * keep using isPublicVendorStatus() alone, so a hidden link still counts where
 * the operator needs to see it — that's the LeafFilter requirement: recorded,
 * not shown.
 *
 * Use this anywhere the result reaches an anonymous visitor, including
 * schema.org emission — a hidden link leaking into JSON-LD is still a leak,
 * and a less visible one.
 */
export function isPubliclyVisibleVendorLink() {
  // OPE-716 — the visibility half comes from @takemetothefair/db-schema so the
  // app and the MCP `list_event_vendors` tool cannot disagree about it again.
  // They already did: this function had the guard and that tool did not, so
  // `public_visible=false` suppressed the vendor here and not there.
  //
  // The status half stays local because it needs PUBLIC_VENDOR_STATUSES from
  // @takemetothefair/constants, which db-schema deliberately does not depend on
  // — and both artifacts already had the status filter right.
  return and(isPublicVendorStatus(), vendorLinkIsPublicallyVisible());
}

// ---------------------------------------------------------------------------
// State-machine transitions
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<EventVendorStatus, EventVendorStatus[]> = {
  [EVENT_VENDOR_STATUS.INVITED]: [
    EVENT_VENDOR_STATUS.INTERESTED,
    EVENT_VENDOR_STATUS.APPLIED,
    EVENT_VENDOR_STATUS.REJECTED,
    EVENT_VENDOR_STATUS.WITHDRAWN,
    EVENT_VENDOR_STATUS.CANCELLED,
  ],
  [EVENT_VENDOR_STATUS.INTERESTED]: [
    EVENT_VENDOR_STATUS.APPLIED,
    EVENT_VENDOR_STATUS.WITHDRAWN,
    EVENT_VENDOR_STATUS.CANCELLED,
  ],
  [EVENT_VENDOR_STATUS.APPLIED]: [
    EVENT_VENDOR_STATUS.WAITLISTED,
    EVENT_VENDOR_STATUS.APPROVED,
    EVENT_VENDOR_STATUS.CONFIRMED,
    EVENT_VENDOR_STATUS.REJECTED,
    EVENT_VENDOR_STATUS.WITHDRAWN,
  ],
  [EVENT_VENDOR_STATUS.WAITLISTED]: [
    EVENT_VENDOR_STATUS.APPROVED,
    EVENT_VENDOR_STATUS.CONFIRMED,
    EVENT_VENDOR_STATUS.REJECTED,
    EVENT_VENDOR_STATUS.WITHDRAWN,
    EVENT_VENDOR_STATUS.CANCELLED,
  ],
  [EVENT_VENDOR_STATUS.APPROVED]: [
    EVENT_VENDOR_STATUS.CONFIRMED,
    EVENT_VENDOR_STATUS.REJECTED,
    EVENT_VENDOR_STATUS.WITHDRAWN,
    EVENT_VENDOR_STATUS.CANCELLED,
  ],
  [EVENT_VENDOR_STATUS.CONFIRMED]: [EVENT_VENDOR_STATUS.WITHDRAWN, EVENT_VENDOR_STATUS.CANCELLED],
  [EVENT_VENDOR_STATUS.REJECTED]: [EVENT_VENDOR_STATUS.APPLIED, EVENT_VENDOR_STATUS.INVITED],
  [EVENT_VENDOR_STATUS.WITHDRAWN]: [EVENT_VENDOR_STATUS.APPLIED, EVENT_VENDOR_STATUS.INTERESTED],
  [EVENT_VENDOR_STATUS.CANCELLED]: [EVENT_VENDOR_STATUS.INVITED],
};

/** Returns true when transitioning from `from` to `to` is allowed. */
export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from as EventVendorStatus];
  return allowed ? allowed.includes(to as EventVendorStatus) : false;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<EventVendorStatus, string> = {
  [EVENT_VENDOR_STATUS.INVITED]: "Invited",
  [EVENT_VENDOR_STATUS.INTERESTED]: "Interested",
  [EVENT_VENDOR_STATUS.APPLIED]: "Applied",
  [EVENT_VENDOR_STATUS.WAITLISTED]: "Waitlisted",
  [EVENT_VENDOR_STATUS.APPROVED]: "Approved",
  [EVENT_VENDOR_STATUS.CONFIRMED]: "Confirmed",
  [EVENT_VENDOR_STATUS.REJECTED]: "Rejected",
  [EVENT_VENDOR_STATUS.WITHDRAWN]: "Withdrawn",
  [EVENT_VENDOR_STATUS.CANCELLED]: "Cancelled",
};

export const STATUS_BADGE_VARIANTS: Record<
  EventVendorStatus,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  [EVENT_VENDOR_STATUS.INVITED]: "info",
  [EVENT_VENDOR_STATUS.INTERESTED]: "default",
  [EVENT_VENDOR_STATUS.APPLIED]: "warning",
  [EVENT_VENDOR_STATUS.WAITLISTED]: "warning",
  [EVENT_VENDOR_STATUS.APPROVED]: "success",
  [EVENT_VENDOR_STATUS.CONFIRMED]: "success",
  [EVENT_VENDOR_STATUS.REJECTED]: "danger",
  [EVENT_VENDOR_STATUS.WITHDRAWN]: "default",
  [EVENT_VENDOR_STATUS.CANCELLED]: "danger",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  [PAYMENT_STATUS.NOT_REQUIRED]: "Not Required",
  [PAYMENT_STATUS.PENDING]: "Pending",
  [PAYMENT_STATUS.PAID]: "Paid",
  [PAYMENT_STATUS.REFUNDED]: "Refunded",
  [PAYMENT_STATUS.OVERDUE]: "Overdue",
};

export const PAYMENT_STATUS_BADGE_VARIANTS: Record<
  PaymentStatus,
  "default" | "success" | "warning" | "danger"
> = {
  [PAYMENT_STATUS.NOT_REQUIRED]: "default",
  [PAYMENT_STATUS.PENDING]: "warning",
  [PAYMENT_STATUS.PAID]: "success",
  [PAYMENT_STATUS.REFUNDED]: "default",
  [PAYMENT_STATUS.OVERDUE]: "danger",
};
