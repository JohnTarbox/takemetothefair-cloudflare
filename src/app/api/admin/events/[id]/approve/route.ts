export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { trackEventStatusChange } from "@/lib/server-analytics";
import { notifyApprovalIfNeeded } from "@/lib/approval-notification";

export const POST = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, session, params }) => {
    const { id } = params;

    try {
      await db
        .update(events)
        .set({ status: "APPROVED", updatedAt: new Date() })
        .where(eq(events.id, id));

      const updatedEvent = await db.select().from(events).where(eq(events.id, id)).limit(1);

      await trackEventStatusChange(db, id, "PENDING", "APPROVED", session.user.id);

      // Notify the submitter if this event was attributed to one and we
      // haven't notified yet. Idempotent — re-approval after un-approval
      // won't re-send. Non-blocking on failure: log + continue so a
      // queue-bound issue doesn't fail the admin's approve action.
      try {
        const cfEnv = getCloudflareEnv() as unknown as { EMAIL_JOBS?: Queue<unknown> };
        await notifyApprovalIfNeeded(db, { EMAIL_JOBS: cfEnv.EMAIL_JOBS }, id);
      } catch (notifyError) {
        await logError(db, {
          message: "Failed to enqueue approval notification (non-blocking)",
          error: notifyError,
          source: "api/admin/events/[id]/approve",
          request,
          context: { eventId: id },
        });
      }

      return NextResponse.json(updatedEvent[0]);
    } catch (error) {
      await logError(db, {
        message: "Failed to approve event",
        error,
        source: "api/admin/events/[id]/approve",
        request,
      });
      return NextResponse.json({ error: "Failed to approve event" }, { status: 500 });
    }
  }
);
