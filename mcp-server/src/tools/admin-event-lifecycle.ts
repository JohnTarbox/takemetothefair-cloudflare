import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, desc, or } from "drizzle-orm";
import { events, adminActions, eventSlugHistory } from "../schema.js";
import {
  EVENT_LIFECYCLE_VALUES,
  PUBLIC_LIFECYCLE_STATUSES,
  type EventLifecycle,
} from "@takemetothefair/constants";
import { decodeHtmlEntities } from "@takemetothefair/utils";
import { jsonContent, publicUrlFor, triggerIndexNow } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

// Mirror src/lib/event-lifecycle.ts:LIFECYCLE_TRANSITIONS. Kept in sync by
// hand because moving the map to @takemetothefair/constants would also
// pull in the Drizzle-dependent publicEventWhere() helper. If a transition
// is added to the main app, mirror it here too. CI doesn't catch drift, so
// the comment on the main-app definition reminds maintainers.
const LIFECYCLE_TRANSITIONS: Record<EventLifecycle, EventLifecycle[]> = {
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

function isPublicLifecycle(lifecycle: EventLifecycle): boolean {
  return (PUBLIC_LIFECYCLE_STATUSES as readonly string[]).includes(lifecycle);
}

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  INDEXNOW_KEY?: string;
}

export function registerEventLifecycleTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "update_event_lifecycle",
    [
      "Transition an event's lifecycle_status with full bookkeeping: validates",
      "the transition, swaps dates for RESCHEDULED/POSTPONED, writes admin_actions",
      "audit row keyed event.lifecycle_change, and fires IndexNow on public-visibility",
      "boundary crossings. Mirror of /api/admin/events/[id]/lifecycle PATCH — use",
      "either; both write the same audit trail.",
      "",
      "Lifecycle states map to schema.org Event statuses: SCHEDULED/TENTATIVE →",
      "EventScheduled, POSTPONED → EventPostponed, RESCHEDULED → EventRescheduled,",
      "CANCELLED → EventCancelled, MOVED_ONLINE → EventMovedOnline. OCCURRED and",
      "NO_SHOW are MMATF-specific past-event annotations with no schema.org",
      "equivalent.",
    ].join(" "),
    {
      event_id: z.string().min(1).describe("Event UUID."),
      new_lifecycle: z
        .enum(EVENT_LIFECYCLE_VALUES as unknown as [string, ...string[]])
        .describe(
          "Target lifecycle. Transition legality is enforced server-side; an invalid transition returns an error with the list of allowed targets from the current state."
        ),
      reason: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Optional human-readable explanation (free text, decoded for HTML entities). Stored in events.lifecycle_reason and the admin_actions payload."
        ),
      new_start_date: z
        .string()
        .datetime()
        .optional()
        .describe("ISO 8601. Required for RESCHEDULED; ignored otherwise."),
      new_end_date: z
        .string()
        .datetime()
        .optional()
        .describe("ISO 8601. Required for RESCHEDULED; ignored otherwise."),
    },
    async (params) => {
      const { event_id, new_lifecycle, reason, new_start_date, new_end_date } = params;
      const decodedReason = reason ? decodeHtmlEntities(reason) : null;
      const to = new_lifecycle as EventLifecycle;

      const [current] = await db
        .select({
          id: events.id,
          slug: events.slug,
          lifecycleStatus: events.lifecycleStatus,
          startDate: events.startDate,
          endDate: events.endDate,
        })
        .from(events)
        .where(eq(events.id, event_id))
        .limit(1);

      if (!current) {
        return {
          content: [jsonContent({ error: "event_not_found", event_id })],
          isError: true,
        };
      }

      const from = current.lifecycleStatus as EventLifecycle;

      if (from === to) {
        return {
          content: [
            jsonContent({
              error: "no_op_transition",
              from,
              to,
              hint: `event is already in lifecycle '${to}'`,
            }),
          ],
          isError: true,
        };
      }

      const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
      if (!allowed.includes(to)) {
        return {
          content: [
            jsonContent({
              error: "invalid_transition",
              message: `transition ${from} → ${to} is not permitted`,
              from,
              to,
              allowed_targets: allowed,
            }),
          ],
          isError: true,
        };
      }

      if (to === "RESCHEDULED" && (!new_start_date || !new_end_date)) {
        return {
          content: [
            jsonContent({
              error: "missing_new_dates",
              message: "RESCHEDULED transition requires both new_start_date and new_end_date.",
            }),
          ],
          isError: true,
        };
      }

      // Compute date updates for RESCHEDULED / POSTPONED. Other transitions
      // leave dates untouched.
      const dateUpdate: {
        startDate?: Date | null;
        endDate?: Date | null;
        previousStartDate?: Date | null;
        previousEndDate?: Date | null;
        datesConfirmed?: boolean;
      } = {};
      if (to === "RESCHEDULED") {
        dateUpdate.startDate = new Date(new_start_date!);
        dateUpdate.endDate = new Date(new_end_date!);
        dateUpdate.previousStartDate = current.startDate ?? null;
        dateUpdate.previousEndDate = current.endDate ?? null;
        dateUpdate.datesConfirmed = true;
      } else if (to === "POSTPONED") {
        dateUpdate.startDate = null;
        dateUpdate.endDate = null;
        dateUpdate.previousStartDate = current.startDate ?? null;
        dateUpdate.previousEndDate = current.endDate ?? null;
        dateUpdate.datesConfirmed = false;
      }

      const now = new Date();
      await db
        .update(events)
        .set({
          lifecycleStatus: to,
          lifecycleStatusChangedAt: now,
          lifecycleReason: decodedReason,
          updatedAt: now,
          ...dateUpdate,
        })
        .where(eq(events.id, event_id));

      await db.insert(adminActions).values({
        action: "event.lifecycle_change",
        actorUserId: auth.userId,
        targetType: "event",
        targetId: event_id,
        payloadJson: JSON.stringify({
          previous_lifecycle: from,
          new_lifecycle: to,
          reason: decodedReason,
          slug: current.slug,
        }),
        createdAt: now,
      });

      // IndexNow on public-visibility boundary crossings. Both directions
      // matter — going private (→ CANCELLED) removes from index; coming
      // back public re-submits.
      let indexNowFired = false;
      if (env && isPublicLifecycle(from) !== isPublicLifecycle(to)) {
        await triggerIndexNow(
          publicUrlFor("events", current.slug),
          env,
          `event-lifecycle-${to.toLowerCase()}`
        );
        indexNowFired = true;
      }

      return {
        content: [
          jsonContent({
            success: true,
            event_id,
            slug: current.slug,
            from,
            to,
            reason: decodedReason,
            dates_changed: to === "RESCHEDULED" || to === "POSTPONED",
            previous_start_date: dateUpdate.previousStartDate?.toISOString() ?? null,
            previous_end_date: dateUpdate.previousEndDate?.toISOString() ?? null,
            indexnow_fired: indexNowFired,
          }),
        ],
      };
    }
  );

  server.tool(
    "get_event_lifecycle_history",
    [
      "Read the lifecycle + status transition history for one event, joined with",
      "slug-rename history. Returns a chronological timeline of state changes for",
      "forensic / audit use — useful for answering 'when did this become CANCELLED'",
      "and 'what was the previous slug before that 301'.",
      "",
      "Sources:",
      "  - admin_actions WHERE action IN (event.lifecycle_change, event.status_change)",
      "  - event_slug_history WHERE event_id = <id>",
      "  - events row for current state",
      "",
      "Events created before the MCP audit hook existed (most pre-2026-04 rows) will",
      "have empty history. Audit gaps documented in the original PR #157 thread.",
    ].join(" "),
    {
      event_id: z.string().min(1).describe("Event UUID."),
    },
    async (params) => {
      const { event_id } = params;

      const [eventRow] = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          status: events.status,
          lifecycleStatus: events.lifecycleStatus,
          lifecycleStatusChangedAt: events.lifecycleStatusChangedAt,
          lifecycleReason: events.lifecycleReason,
          previousStartDate: events.previousStartDate,
          previousEndDate: events.previousEndDate,
          startDate: events.startDate,
          endDate: events.endDate,
        })
        .from(events)
        .where(eq(events.id, event_id))
        .limit(1);

      if (!eventRow) {
        return {
          content: [jsonContent({ error: "event_not_found", event_id })],
          isError: true,
        };
      }

      const actions = await db
        .select({
          id: adminActions.id,
          action: adminActions.action,
          actorUserId: adminActions.actorUserId,
          payloadJson: adminActions.payloadJson,
          createdAt: adminActions.createdAt,
        })
        .from(adminActions)
        .where(
          and(
            eq(adminActions.targetType, "event"),
            eq(adminActions.targetId, event_id),
            or(
              eq(adminActions.action, "event.lifecycle_change"),
              eq(adminActions.action, "event.status_change")
            )
          )
        )
        .orderBy(desc(adminActions.createdAt));

      const slugChanges = await db
        .select({
          oldSlug: eventSlugHistory.oldSlug,
          newSlug: eventSlugHistory.newSlug,
          changedAt: eventSlugHistory.changedAt,
        })
        .from(eventSlugHistory)
        .where(eq(eventSlugHistory.eventId, event_id))
        .orderBy(desc(eventSlugHistory.changedAt));

      const timeline = [
        ...actions.map((a) => {
          let payload: Record<string, unknown> | null = null;
          if (a.payloadJson) {
            try {
              payload = JSON.parse(a.payloadJson) as Record<string, unknown>;
            } catch {
              payload = null;
            }
          }
          return {
            at: a.createdAt ? Math.floor(a.createdAt.getTime() / 1000) : null,
            kind: a.action,
            actor_user_id: a.actorUserId,
            details: payload,
          };
        }),
        ...slugChanges.map((s) => ({
          at: s.changedAt ? Math.floor(s.changedAt.getTime() / 1000) : null,
          kind: "event.slug_change",
          actor_user_id: null,
          details: { old_slug: s.oldSlug, new_slug: s.newSlug },
        })),
      ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

      return {
        content: [
          jsonContent({
            event_id: eventRow.id,
            slug: eventRow.slug,
            name: eventRow.name,
            current_state: {
              status: eventRow.status,
              lifecycle_status: eventRow.lifecycleStatus,
              lifecycle_status_changed_at: eventRow.lifecycleStatusChangedAt
                ? Math.floor(eventRow.lifecycleStatusChangedAt.getTime() / 1000)
                : null,
              lifecycle_reason: eventRow.lifecycleReason,
              start_date: eventRow.startDate?.toISOString() ?? null,
              end_date: eventRow.endDate?.toISOString() ?? null,
              previous_start_date: eventRow.previousStartDate?.toISOString() ?? null,
              previous_end_date: eventRow.previousEndDate?.toISOString() ?? null,
            },
            timeline,
            timeline_entry_count: timeline.length,
            audit_gap_warning:
              actions.length === 0
                ? "No audit entries. Event predates the audit hook OR was modified only via direct D1 writes (bulk import / pre-2026-04 scrapers)."
                : null,
          }),
        ],
      };
    }
  );
}
