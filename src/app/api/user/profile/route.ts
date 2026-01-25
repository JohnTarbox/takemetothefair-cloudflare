import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";


export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name } = body;

    const db = getCloudflareDb();
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
    console.error("Failed to update profile:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
