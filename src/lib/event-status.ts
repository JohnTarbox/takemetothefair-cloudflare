/**
 * Event status helpers — centralizes public-visibility logic
 * for events, paralleling vendor-status.ts for eventVendors.
 */

import { publicEventWhere } from "@/lib/event-lifecycle";

/** Drizzle WHERE clause combining editorial visibility (APPROVED/TENTATIVE)
 *  with the lifecycle gate (excludes CANCELLED/NO_SHOW). All existing
 *  callers of isPublicEventStatus() automatically get the lifecycle gate
 *  via this delegation — see src/lib/event-lifecycle.ts for the rationale. */
export function isPublicEventStatus() {
  return publicEventWhere();
}

/** Check if an event status is tentative */
export function isTentativeEvent(status: string) {
  return status === "TENTATIVE";
}
