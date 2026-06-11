export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, adminActions } from "@/lib/db/schema";
import {
  validateLifecycleTransition,
  swapDatesForLifecycle,
  isPublicLifecycle,
  type EventLifecycle,
} from "@/lib/event-lifecycle";
import { eventLifecycleUpdateSchema, validateRequestBody } from "@/lib/validations";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { logError } from "@/lib/logger";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/events/[id]/lifecycle
 *
 * Transitions an event's lifecycle_status with full bookkeeping:
 *   - validates transition against LIFECYCLE_TRANSITIONS
 *   - writes lifecycle_status, lifecycle_status_changed_at, lifecycle_reason
 *   - swaps dates for RESCHEDULED (current → previous, new → current)
 *     and POSTPONED (current → previous, dates → null)
 *   - logs an admin_actions row keyed `event.lifecycle_change` with the
 *     previous + new lifecycle, reason, and slug (matches the pattern used by
 *     the MCP server's update_event_status transition logging)
 *   - fires IndexNow when public visibility is affected (a transition that
 *     crosses the isPublicLifecycle() boundary either direction)
 *
 * Auth: admin session only. (X-Internal-Key is intentionally not accepted
 * here — lifecycle is a deliberate human/admin decision, not a sweep.)
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const parsed = await validateRequestBody(request, eventLifecycleUpdateSchema);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });
  }
  const { new_lifecycle, reason, new_start_date, new_end_date } = parsed.data;

  const db = getCloudflareDb();
  try {
    const [current] = await db
      .select({
        id: events.id,
        slug: events.slug,
        lifecycleStatus: events.lifecycleStatus,
        startDate: events.startDate,
        endDate: events.endDate,
      })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);
    if (!current) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const from = current.lifecycleStatus as EventLifecycle;
    const to = new_lifecycle as EventLifecycle;

    const check = validateLifecycleTransition(from, to);
    if (!check.ok) {
      return NextResponse.json(
        {
          error: "invalid_transition",
          message: check.reason,
          from,
          to,
          allowed: check.allowed,
        },
        { status: 400 }
      );
    }

    // Compute date updates for RESCHEDULED / POSTPONED.
    let dateUpdate: {
      startDate?: Date | null;
      endDate?: Date | null;
      previousStartDate?: Date | null;
      previousEndDate?: Date | null;
      datesConfirmed?: boolean;
    } = {};
    if (to === "RESCHEDULED") {
      const swap = swapDatesForLifecycle(
        { startDate: current.startDate ?? null, endDate: current.endDate ?? null },
        {
          startDate: new_start_date ? new Date(new_start_date) : null,
          endDate: new_end_date ? new Date(new_end_date) : null,
        }
      );
      dateUpdate = {
        startDate: swap.startDate,
        endDate: swap.endDate,
        previousStartDate: swap.previousStartDate,
        previousEndDate: swap.previousEndDate,
        datesConfirmed: true,
      };
    } else if (to === "POSTPONED") {
      // Postpone: save current dates as previous, clear current dates.
      // datesConfirmed → false signals "we don't know when this will be" to
      // the rest of the rendering pipeline.
      dateUpdate = {
        startDate: null,
        endDate: null,
        previousStartDate: current.startDate ?? null,
        previousEndDate: current.endDate ?? null,
        datesConfirmed: false,
      };
    }

    const now = new Date();
    await db
      .update(events)
      .set({
        lifecycleStatus: to,
        lifecycleStatusChangedAt: now,
        lifecycleReason: reason ?? null,
        updatedAt: now,
        ...dateUpdate,
      })
      .where(eq(events.id, id));

    await db.insert(adminActions).values({
      action: "event.lifecycle_change",
      actorUserId: session.user.id,
      targetType: "event",
      targetId: id,
      payloadJson: JSON.stringify({
        previous_lifecycle: from,
        new_lifecycle: to,
        reason: reason ?? null,
        slug: current.slug,
      }),
      createdAt: now,
    });

    // IndexNow on public-visibility boundary crossings. Both directions
    // matter — going private (→ CANCELLED) should remove from index; going
    // public again (CANCELLED → SCHEDULED) should re-submit.
    if (isPublicLifecycle(from) !== isPublicLifecycle(to)) {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(
        db,
        indexNowUrlFor("events", current.slug),
        env,
        `event-lifecycle-${to.toLowerCase()}`
      );
    }

    return NextResponse.json({ success: true, from, to });
  } catch (error) {
    await logError(db, {
      message: "Failed to update event lifecycle",
      error,
      source: "api/admin/events/[id]/lifecycle",
      request,
    });
    return NextResponse.json({ error: "Failed to update lifecycle" }, { status: 500 });
  }
}
