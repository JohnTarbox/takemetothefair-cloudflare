/**
 * Event status helpers — centralizes public-visibility logic
 * for events, paralleling vendor-status.ts for eventVendors.
 */

import { inArray } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";

/** Drizzle WHERE clause: status IN (APPROVED, TENTATIVE) */
export function isPublicEventStatus() {
  return inArray(events.status, [...PUBLIC_EVENT_STATUSES]);
}

/** Check if an event status is tentative */
export function isTentativeEvent(status: string) {
  return status === "TENTATIVE";
}
