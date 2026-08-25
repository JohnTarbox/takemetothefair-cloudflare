/**
 * Event lifecycle helpers — centralizes the "what's actually happening with
 * this event" state. Orthogonal to `events.status` (editorial workflow).
 *
 * The lifecycle vocabulary maps to schema.org Event status URIs so the JSON-LD
 * we emit on event pages stays consistent with Google's rich-snippet
 * vocabulary. Three states (OCCURRED, NO_SHOW, TENTATIVE) are MMATF additions
 * for past-event semantics and dates-not-yet-confirmed; the other five map
 * 1:1 to schema.org.
 *
 * Source of truth — do NOT redefine these values inline. The schema enum at
 * packages/db-schema/src/index.ts mirrors this list.
 */

import { inArray, and } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import {
  EVENT_LIFECYCLE,
  EVENT_LIFECYCLE_VALUES,
  PUBLIC_EVENT_STATUSES,
  PUBLIC_LIFECYCLE_STATUSES,
  type EventLifecycle,
} from "@takemetothefair/constants";

export { EVENT_LIFECYCLE, EVENT_LIFECYCLE_VALUES, PUBLIC_LIFECYCLE_STATUSES };
export type { EventLifecycle };

// ---------------------------------------------------------------------------
// Schema.org URI map
// ---------------------------------------------------------------------------
//
// Drives EventSchema.tsx JSON-LD emission and the denormalized
// event_schema_org.schema_event_status cache.
//
// TENTATIVE maps to EventScheduled by convention — schema.org has no
// "dates-not-confirmed" status, and treating a TENTATIVE event as Scheduled
// matches how Google indexes it. The TENTATIVE distinction lives only in our
// internal UI.
//
// OCCURRED and NO_SHOW have no schema.org equivalent (the spec assumes future
// events). For past events we omit the eventStatus field entirely — see the
// helper below. Listed here as `null` to make that explicit.

export const LIFECYCLE_TO_SCHEMA_ORG: Record<EventLifecycle, string | null> = {
  SCHEDULED: "https://schema.org/EventScheduled",
  TENTATIVE: "https://schema.org/EventScheduled",
  POSTPONED: "https://schema.org/EventPostponed",
  RESCHEDULED: "https://schema.org/EventRescheduled",
  CANCELLED: "https://schema.org/EventCancelled",
  OCCURRED: null,
  MOVED_ONLINE: "https://schema.org/EventMovedOnline",
  NO_SHOW: null,
};

/** Returns the schema.org Event status URI for the given lifecycle, or null
 *  for past-event statuses without a schema.org equivalent. */
export function schemaOrgEventStatusFor(lifecycle: EventLifecycle): string | null {
  return LIFECYCLE_TO_SCHEMA_ORG[lifecycle];
}

// ---------------------------------------------------------------------------
// Public visibility
// ---------------------------------------------------------------------------
//
// An event is publicly visible when BOTH:
//   - editorial status = APPROVED (not DRAFT/PENDING/REJECTED/legacy CANCELLED)
//   - lifecycle status NOT IN (CANCELLED, NO_SHOW) — cancelled and no-show
//     events are hidden by design
//
// OCCURRED past events remain public — they're evergreen SEO content
// ("[event] was held annually at [venue]"). MOVED_ONLINE and POSTPONED stay
// visible so visitors learn about the change.

export function isPublicLifecycle(lifecycle: EventLifecycle): boolean {
  return (PUBLIC_LIFECYCLE_STATUSES as readonly string[]).includes(lifecycle);
}

/** In-memory equivalent of publicEventWhere() — used by callers that
 *  have already fetched a row and need to gate on (status, lifecycle)
 *  fields without a separate DB round-trip. Examples: middleware deciding
 *  404 vs render, post-SELECT visibility refinements. */
export function isPubliclyVisible(status: string, lifecycle: EventLifecycle): boolean {
  return (
    (PUBLIC_EVENT_STATUSES as readonly string[]).includes(status) && isPublicLifecycle(lifecycle)
  );
}

/** Drizzle WHERE clause combining the editorial visibility set with the
 *  lifecycle gate. The single source-of-truth for "should this event appear
 *  publicly?" — replaces the bare PUBLIC_EVENT_STATUSES check at all
 *  public-surface sites.
 *
 *  Editorial side preserves the legacy PUBLIC_EVENT_STATUSES set (APPROVED
 *  + TENTATIVE) so existing TENTATIVE-editorial events stay visible; the
 *  PR 1 migration intentionally does NOT migrate editorial TENTATIVE
 *  events to APPROVED. Lifecycle side excludes CANCELLED and NO_SHOW so
 *  these never leak into sitemaps/feeds even if the editorial side hasn't
 *  been updated yet. */
export function publicEventWhere() {
  return and(
    inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
    inArray(events.lifecycleStatus, [...PUBLIC_LIFECYCLE_STATUSES])
  );
}

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------
//
// State-machine transitions for lifecycle.
//
// OPE-487 (2026-08-25): the table and its validator MOVED to
// @takemetothefair/constants and are re-exported here, so the app route, the
// MCP tool and the OCCURRED sweep all read one definition. They were previously
// two hand-synced copies — see the note on the constants definition for why
// that was a bad arrangement for a safety guard specifically.
//
// `publicEventWhere()` below stays here: it is Drizzle-dependent, which is what
// kept the whole module out of constants in the first place.

export {
  LIFECYCLE_TRANSITIONS,
  TERMINAL_LIFECYCLE_STATUSES,
  validateLifecycleTransition,
} from "@takemetothefair/constants";
export type { TransitionResult, LifecycleTransitionContext } from "@takemetothefair/constants";

// ---------------------------------------------------------------------------
// Date-swap helper for RESCHEDULED / POSTPONED
// ---------------------------------------------------------------------------

export interface DateSwapResult {
  startDate: Date | null;
  endDate: Date | null;
  previousStartDate: Date | null;
  previousEndDate: Date | null;
}

/** When transitioning to RESCHEDULED with new dates, capture the current
 *  pair into previousStart/EndDate and adopt the new pair. POSTPONED uses
 *  the same shape but with null new dates (dates not yet known). */
export function swapDatesForLifecycle(
  current: { startDate: Date | null; endDate: Date | null },
  next: { startDate: Date | null; endDate: Date | null }
): DateSwapResult {
  return {
    startDate: next.startDate,
    endDate: next.endDate,
    previousStartDate: current.startDate,
    previousEndDate: current.endDate,
  };
}
