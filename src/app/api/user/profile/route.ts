import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { validateRequestBody, userProfileUpdateSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";


export async function PATCH(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const validation = await validateRequestBody(request, userProfileUpdateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { name } = validation.data;
    await db
      .update(users)
      .set({ name, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));

    const updatedUser = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    return NextResponse.json(updatedUser[0]);
  } catch (error) {
    await logError(db, { message: "Failed to update profile", error, source: "api/user/profile", request });
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
