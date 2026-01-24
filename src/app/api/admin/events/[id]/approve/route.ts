import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "edge";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const db = getCloudflareDb();

    await db
      .update(events)
      .set({ status: "APPROVED", updatedAt: new Date() })
      .where(eq(events.id, id));

    const updatedEvent = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return NextResponse.json(updatedEvent[0]);
  } catch (error) {
    console.error("Failed to approve event:", error);
    return NextResponse.json({ error: "Failed to approve event" }, { status: 500 });
  }
}
