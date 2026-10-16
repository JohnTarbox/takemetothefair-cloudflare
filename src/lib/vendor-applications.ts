/**
 * OPE-1361 — the ONE rule for a vendor putting itself on an event.
 *
 * Two main-app surfaces let a vendor create or change its own `event_vendors`
 * row:
 *   - the session route  `POST  /api/vendor/applications`
 *   - the token route    `PATCH /api/vendors/[slug]/applications` (mmatf_ token)
 *
 * The token route used to default to CONFIRMED and insert for any eventId, with
 * no canSelfConfirm / event-status / commercial / email-verification check, so
 * any self-registered vendor could mint a token and publish itself as a
 * confirmed vendor of any event. Both routes now ask this module.
 *
 * MCP `apply_to_event` (mcp-server/src/tools/vendor.ts) enforces the same
 * canSelfConfirm + commercial rule in its own copy (the MCP Worker cannot
 * import from src/lib). It differs in one respect: it also accepts TENTATIVE
 * events, where this rule (matching the session route) accepts APPROVED only.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { eventVendors, events, users, vendors } from "@/lib/db/schema";
import {
  EVENT_VENDOR_STATUS,
  EVENT_VENDOR_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  type EventVendorStatus,
  type PaymentStatus,
} from "@/lib/constants";
import { isValidTransition } from "@/lib/vendor-status";

export type RuleRefusal = { ok: false; httpStatus: number; error: string; message?: string };

/**
 * Organizer decisions a canSelfConfirm (trusted) vendor may record itself.
 * WAITLISTED is here because the live token client (Maine Cardworks'
 * show tracker, apps/shows/src/lib/mmf-push.ts) reports "the organizer
 * waitlisted us" through this route.
 */
export const SELF_CONFIRM_ONLY_STATUSES: readonly EventVendorStatus[] = [
  EVENT_VENDOR_STATUS.WAITLISTED,
  EVENT_VENDOR_STATUS.APPROVED,
  EVENT_VENDOR_STATUS.CONFIRMED,
];

/**
 * Statuses a vendor may set on its own row. REJECTED, INVITED and CANCELLED
 * are always a promoter/admin decision.
 */
export function vendorSettableStatuses(canSelfConfirm: boolean): readonly EventVendorStatus[] {
  const base: EventVendorStatus[] = [
    EVENT_VENDOR_STATUS.INTERESTED,
    EVENT_VENDOR_STATUS.APPLIED,
    EVENT_VENDOR_STATUS.WITHDRAWN,
  ];
  return canSelfConfirm ? [...base, ...SELF_CONFIRM_ONLY_STATUSES] : base;
}

/** Statuses that put (or keep) the vendor ON the event — these need the event gate. */
const JOINING_STATUSES: readonly EventVendorStatus[] = [
  EVENT_VENDOR_STATUS.INTERESTED,
  EVENT_VENDOR_STATUS.APPLIED,
  EVENT_VENDOR_STATUS.WAITLISTED,
  EVENT_VENDOR_STATUS.APPROVED,
  EVENT_VENDOR_STATUS.CONFIRMED,
];

/**
 * Can this vendor join this event at all? Same checks, same messages, as the
 * session route has always returned.
 */
export function checkEventAcceptsVendor(
  vendor: { commercial: boolean | null },
  event: { status: string; commercialVendorsAllowed: boolean | null }
): { ok: true } | RuleRefusal {
  if (event.status !== "APPROVED") {
    return {
      ok: false,
      httpStatus: 400,
      error: "This event is not currently accepting vendor applications",
    };
  }
  if (vendor.commercial && !event.commercialVendorsAllowed) {
    return {
      ok: false,
      httpStatus: 403,
      error: "This event does not allow commercial vendors. Only non-commercial vendors may apply.",
    };
  }
  return { ok: true };
}

/** Initial status of a new self-submitted application. */
export function defaultApplicationStatus(canSelfConfirm: boolean | null): EventVendorStatus {
  return canSelfConfirm ? EVENT_VENDOR_STATUS.CONFIRMED : EVENT_VENDOR_STATUS.APPLIED;
}

export function isEventVendorStatus(v: unknown): v is EventVendorStatus {
  return typeof v === "string" && (EVENT_VENDOR_STATUS_VALUES as readonly string[]).includes(v);
}

export function isPaymentStatus(v: unknown): v is PaymentStatus {
  return typeof v === "string" && (PAYMENT_STATUS_VALUES as readonly string[]).includes(v);
}

export const EMAIL_UNVERIFIED_REFUSAL: RuleRefusal = {
  ok: false,
  httpStatus: 403,
  error: "email_unverified",
  message:
    "Please verify your email address before continuing. Check your inbox for the verification link, or request a new one from your dashboard.",
};

export type TokenPatchBody = { eventId?: unknown; status?: unknown; paymentStatus?: unknown };

export type TokenPatchResult =
  | {
      ok: true;
      httpStatus: 200 | 201;
      body: Record<string, unknown>;
    }
  | RuleRefusal;

/**
 * The token route's whole decision: create or update the vendor's own
 * `event_vendors` row for `body.eventId`, under the same rules as the session
 * route (verified email, APPROVED event, commercial rule, canSelfConfirm),
 * with status changes held to `vendorSettableStatuses` AND the
 * `VALID_TRANSITIONS` state machine, and `paymentStatus` held to its enum.
 */
export async function applyVendorTokenPatch(
  db: Database,
  vendorId: string,
  body: TokenPatchBody
): Promise<TokenPatchResult> {
  if (typeof body.eventId !== "string" || body.eventId.length === 0) {
    return { ok: false, httpStatus: 400, error: "eventId is required" };
  }
  const eventId = body.eventId;

  if (body.status !== undefined && !isEventVendorStatus(body.status)) {
    return {
      ok: false,
      httpStatus: 400,
      error: `Invalid status. Must be one of: ${EVENT_VENDOR_STATUS_VALUES.join(", ")}`,
    };
  }
  if (body.paymentStatus !== undefined && !isPaymentStatus(body.paymentStatus)) {
    return {
      ok: false,
      httpStatus: 400,
      error: `Invalid paymentStatus. Must be one of: ${PAYMENT_STATUS_VALUES.join(", ")}`,
    };
  }
  const requestedStatus = body.status as EventVendorStatus | undefined;
  const requestedPayment = body.paymentStatus as PaymentStatus | undefined;

  const [vendor] = await db
    .select({
      commercial: vendors.commercial,
      canSelfConfirm: vendors.canSelfConfirm,
      emailVerified: users.emailVerified,
    })
    .from(vendors)
    .innerJoin(users, eq(vendors.userId, users.id))
    .where(eq(vendors.id, vendorId))
    .limit(1);

  if (!vendor) {
    return { ok: false, httpStatus: 404, error: "Vendor profile not found" };
  }
  // Same gate the session route applies via requireVerifiedSession().
  if (!vendor.emailVerified) return EMAIL_UNVERIFIED_REFUSAL;

  const canSelfConfirm = vendor.canSelfConfirm ?? false;
  const settable = vendorSettableStatuses(canSelfConfirm);

  const loadEvent = async () => {
    const [event] = await db
      .select({ status: events.status, commercialVendorsAllowed: events.commercialVendorsAllowed })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    return event;
  };

  const refuseStatus = (s: EventVendorStatus): RuleRefusal =>
    SELF_CONFIRM_ONLY_STATUSES.includes(s) && !canSelfConfirm
      ? {
          ok: false,
          httpStatus: 403,
          error: `${s} is set by the event organizer. Submit an application (APPLIED) instead.`,
        }
      : { ok: false, httpStatus: 400, error: `A vendor cannot set its own status to ${s}` };

  const [existing] = await db
    .select()
    .from(eventVendors)
    .where(and(eq(eventVendors.vendorId, vendorId), eq(eventVendors.eventId, eventId)))
    .limit(1);

  if (!existing) {
    const newStatus = requestedStatus ?? defaultApplicationStatus(canSelfConfirm);
    // A new row can only be a joining status the vendor is allowed to set.
    if (!settable.includes(newStatus) || !JOINING_STATUSES.includes(newStatus)) {
      return refuseStatus(newStatus);
    }

    const event = await loadEvent();
    if (!event) return { ok: false, httpStatus: 404, error: "Event not found" };
    const gate = checkEventAcceptsVendor(vendor, event);
    if (!gate.ok) return gate;

    const newPayment = requestedPayment ?? PAYMENT_STATUS.NOT_REQUIRED;
    await db.insert(eventVendors).values({
      eventId,
      vendorId,
      status: newStatus,
      paymentStatus: newPayment,
    });

    return {
      ok: true,
      httpStatus: 201,
      body: { eventId, status: newStatus, paymentStatus: newPayment, created: true },
    };
  }

  const updates: { status?: EventVendorStatus; paymentStatus?: PaymentStatus } = {};

  if (requestedStatus && requestedStatus !== existing.status) {
    if (!settable.includes(requestedStatus)) return refuseStatus(requestedStatus);
    if (!isValidTransition(existing.status, requestedStatus)) {
      return {
        ok: false,
        httpStatus: 400,
        error: `Cannot transition from ${existing.status} to ${requestedStatus}`,
      };
    }
    // Re-joining (e.g. WITHDRAWN → APPLIED) needs the event to still accept vendors.
    if (JOINING_STATUSES.includes(requestedStatus)) {
      const event = await loadEvent();
      if (!event) return { ok: false, httpStatus: 404, error: "Event not found" };
      const gate = checkEventAcceptsVendor(vendor, event);
      if (!gate.ok) return gate;
    }
    updates.status = requestedStatus;
  }

  if (requestedPayment && requestedPayment !== existing.paymentStatus) {
    updates.paymentStatus = requestedPayment;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: true, httpStatus: 200, body: { message: "No changes" } };
  }

  await db
    .update(eventVendors)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(eventVendors.id, existing.id));

  return {
    ok: true,
    httpStatus: 200,
    body: {
      eventId,
      status: updates.status ?? existing.status,
      paymentStatus: updates.paymentStatus ?? existing.paymentStatus,
    },
  };
}
