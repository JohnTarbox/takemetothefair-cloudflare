export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { trackEventStatusChange } from "@/lib/server-analytics";

export const POST = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, session, params }) => {
    const { id } = params;

    try {
      await db
        .update(events)
        .set({ status: "REJECTED", updatedAt: new Date() })
        .where(eq(events.id, id));

      const updatedEvent = await db.select().from(events).where(eq(events.id, id)).limit(1);

      await trackEventStatusChange(db, id, "PENDING", "REJECTED", session.user.id);
      return NextResponse.json(updatedEvent[0]);
    } catch (error) {
      await logError(db, {
        message: "Failed to reject event",
        error,
        source: "api/admin/events/[id]/reject",
        request,
      });
      return NextResponse.json({ error: "Failed to reject event" }, { status: 500 });
    }
  }
);
