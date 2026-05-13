import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { events, adminActions } from "../schema.js";
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
}
