export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { userUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Validate request body
  const validation = await validateRequestBody(request, userUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  const db = getCloudflareDb();
  try {
    // WS3d — snapshot the prior role so a role change can be audited with the
    // previous → new transition (admin elevating/demoting a user is a
    // privileged action and must leave a trail).
    const [priorUser] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.role) updateData.role = data.role;
    if (data.name !== undefined) updateData.name = data.name;

    await db.update(users).set(updateData).where(eq(users.id, id));

    // WS3d — audit row when the role actually transitions (compare against the
    // snapshot so a no-op PATCH or a name-only edit doesn't spam the log).
    if (data.role && priorUser && data.role !== priorUser.role) {
      await db.insert(adminActions).values({
        action: "user.role_change",
        actorUserId: session.user.id,
        targetType: "user",
        targetId: id,
        payloadJson: JSON.stringify({
          previous_role: priorUser.role,
          new_role: data.role,
        }),
        createdAt: new Date(),
      });
    }

    const [updatedUser] = await db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return NextResponse.json(updatedUser);
  } catch (error) {
    await logError(db, {
      message: "Failed to update user",
      error,
      source: "api/admin/users/[id]",
      request,
    });
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
