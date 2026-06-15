import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, desc, or } from "drizzle-orm";
import { events, adminActions, eventSlugHistory } from "../schema.js";
import { EVENT_LIFECYCLE_VALUES, type EventLifecycle } from "@takemetothefair/constants";
import { decodeHtmlEntities } from "@takemetothefair/utils";
import { jsonContent, publicUrlFor, triggerIndexNow } from "../helpers.js";
import { LIFECYCLE_TRANSITIONS, isPublicLifecycle } from "../lifecycle.js";
import { rolloverEventIfRecurring } from "../event-rollover.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

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

      // K27 — when an admin marks an event OCCURRED, roll a recurring event
      // forward to its next-occurrence TENTATIVE edition (idempotent + gated;
      // a non-recurring event is a no-op). Best-effort: a rollover failure must
      // not fail the lifecycle transition the operator just performed.
      let rolledOverEventId: string | null = null;
      if (to === "OCCURRED") {
        try {
          const roll = await rolloverEventIfRecurring(db, event_id, {
            via: "manual",
            actorUserId: auth.userId,
          });
          if (roll.created) rolledOverEventId = roll.newEventId ?? null;
        } catch {
          // swallow — the transition already committed; the daily sweep's
          // Pass-2 backfill will retry the roll idempotently.
        }
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
            rolled_over_event_id: rolledOverEventId,
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

  // ── merge_events ───────────────────────────────────────────────
  //
  // K3 (analyst, 2026-05-31). Wraps the main-app /api/admin/duplicates/
  // merge endpoint, which now accepts X-Internal-Key auth. The merge
  // logic itself lives in src/lib/duplicates/merge-operations.ts —
  // documented design is rename-dup-slug + insert slug_history + mark
  // REJECTED + merged_into. Preserves SEO equity: the duplicate's
  // original slug 301s to the keeper instead of 404ing.
  //
  // Pre-flight via `preview: true` returns the existing
  // getEventMergePreview() output (relationship counts, warnings about
  // different venue/promoter) so the operator can sanity-check before
  // committing.
  server.tool(
    "merge_events",
    [
      "Merge a duplicate event INTO a keeper, preserving SEO equity via slug-history",
      "redirect. The duplicate row is tombstoned (status='REJECTED' + merged_into=keeper)",
      "with its slug renamed; /events/<original-dup-slug> 301s to the keeper. Transfers",
      "event_vendors, event_days, event_data_citations, content_links (target_type=EVENT),",
      "and user_favorites. Writes admin_actions(action='event.merge') with both ids in the",
      "payload.",
      "",
      "Use preview=true first to see what will change and whether there are warnings",
      "(different promoter, different venue, overlapping vendors). Refuses to merge an",
      "event with itself or one that's already merged.",
    ].join(" "),
    {
      keeper_event_id: z
        .string()
        .min(1)
        .describe("Event ID to keep (winner). Receives transferred children + slug history."),
      duplicate_event_id: z
        .string()
        .min(1)
        .describe(
          "Event ID to merge in (loser). Slug renamed to <orig>-merged-<id8>; status set to REJECTED; merged_into points at keeper."
        ),
      preview: z
        .boolean()
        .optional()
        .describe(
          "If true, return relationship counts + warnings without committing. Defaults to false."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [{ type: "text", text: "MAIN_APP_URL or INTERNAL_API_KEY not configured." }],
          isError: true,
        };
      }
      if (params.keeper_event_id === params.duplicate_event_id) {
        return {
          content: [{ type: "text", text: "keeper_event_id and duplicate_event_id must differ." }],
          isError: true,
        };
      }

      // K8 (analyst, 2026-06-01). Preview path now lives in the same
      // /api/admin/duplicates/preview endpoint the admin UI uses;
      // K8 part 1 extended that route to accept X-Internal-Key auth.
      // Returns relationship counts + warnings (different promoter,
      // different venue, overlapping vendors) without committing — the
      // operator (or Claude) can sanity-check before invoking the tool
      // a second time with preview=false to actually merge.
      if (params.preview) {
        const previewRes = await fetch(`${env.MAIN_APP_URL}/api/admin/duplicates/preview`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-key": env.INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            type: "events",
            primaryId: params.keeper_event_id,
            duplicateId: params.duplicate_event_id,
          }),
        });
        const previewData = (await previewRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!previewRes.ok) {
          return {
            content: [
              {
                type: "text",
                text: previewData?.error
                  ? `merge_events preview failed: ${previewData.error}`
                  : `merge_events preview failed: HTTP ${previewRes.status}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [jsonContent({ preview: true, ...previewData })],
        };
      }

      const res = await fetch(`${env.MAIN_APP_URL}/api/admin/duplicates/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-key": env.INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          type: "events",
          primaryId: params.keeper_event_id,
          duplicateId: params.duplicate_event_id,
          actorUserId: auth.userId,
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        isTimeout?: boolean;
        mergedEntity?: { id: string; name: string; slug: string };
        transferredRelationships?: Record<string, number>;
        deletedId?: string;
      } | null;

      if (!res.ok || !data?.success) {
        return {
          content: [
            {
              type: "text",
              text: data?.error
                ? `merge_events failed: ${data.error}`
                : `merge_events failed: HTTP ${res.status}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          jsonContent({
            success: true,
            keeper_event_id: params.keeper_event_id,
            tombstoned_event_id: params.duplicate_event_id,
            keeper_slug: data.mergedEntity?.slug ?? null,
            transferred: data.transferredRelationships ?? {},
            // To verify the SEO redirect, query the public URL for the
            // duplicate's ORIGINAL slug (which the operator already
            // knows from looking it up before calling this tool):
            //   curl -sI https://meetmeatthefair.com/events/<original-dup-slug>
            //   → expect HTTP/2 301 + Location: /events/<keeper-slug>
            verify_redirect_hint:
              "GET https://meetmeatthefair.com/events/<original-duplicate-slug> → expect 301 to /events/<keeper-slug>",
          }),
        ],
      };
    }
  );
}
