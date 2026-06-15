/**
 * Event-lifecycle transition map + visibility helper, mirrored from the main
 * app's src/lib/event-lifecycle.ts.
 *
 * Kept in sync with the main-app definition BY HAND — moving the map into
 * @takemetothefair/constants would pull in the Drizzle-dependent
 * publicEventWhere() helper that the main app builds on top of it. If a
 * transition is added to the main app, mirror it here too. CI doesn't catch
 * drift, so the comment on the main-app definition reminds maintainers.
 *
 * Extracted out of admin-event-lifecycle.ts (K27, 2026-06-15) so both the
 * update_event_lifecycle tool and the OCCURRED auto-transition sweep
 * (event-occurred-sweep.ts) share ONE copy instead of hand-duplicating a third.
 */
import { PUBLIC_LIFECYCLE_STATUSES, type EventLifecycle } from "@takemetothefair/constants";

export const LIFECYCLE_TRANSITIONS: Record<EventLifecycle, EventLifecycle[]> = {
  SCHEDULED: [
    "TENTATIVE",
    "POSTPONED",
    "RESCHEDULED",
    "CANCELLED",
    "MOVED_ONLINE",
    "OCCURRED",
    "NO_SHOW",
  ],
  TENTATIVE: ["SCHEDULED", "POSTPONED", "CANCELLED", "MOVED_ONLINE"],
  POSTPONED: ["SCHEDULED", "RESCHEDULED", "CANCELLED"],
  RESCHEDULED: ["SCHEDULED", "POSTPONED", "CANCELLED", "OCCURRED", "NO_SHOW"],
  CANCELLED: ["SCHEDULED", "RESCHEDULED"],
  MOVED_ONLINE: ["CANCELLED", "OCCURRED", "NO_SHOW"],
  OCCURRED: ["NO_SHOW"],
  NO_SHOW: ["OCCURRED"],
};

export function isPublicLifecycle(lifecycle: EventLifecycle): boolean {
  return (PUBLIC_LIFECYCLE_STATUSES as readonly string[]).includes(lifecycle);
}
