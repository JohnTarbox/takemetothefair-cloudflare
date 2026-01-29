import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, promoters, vendors } from "@/lib/db/schema";
import { notInArray } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const available = searchParams.get("available");

  const db = getCloudflareDb();
  try {

    if (available === "promoter") {
      // Get users who don't have a promoter profile
      const existingPromoterUserIds = await db
        .select({ userId: promoters.userId })
        .from(promoters);

      const userIds = existingPromoterUserIds.map((p) => p.userId);

      let userList;
      if (userIds.length > 0) {
        userList = await db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(notInArray(users.id, userIds))
          .orderBy(users.email);
      } else {
        userList = await db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .orderBy(users.email);
      }

      return NextResponse.json(userList);
    }

    if (available === "vendor") {
      // Get users who don't have a vendor profile
      const existingVendorUserIds = await db
        .select({ userId: vendors.userId })
        .from(vendors);

      const userIds = existingVendorUserIds.map((v) => v.userId);

      let userList;
      if (userIds.length > 0) {
        userList = await db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(notInArray(users.id, userIds))
          .orderBy(users.email);
      } else {
        userList = await db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .orderBy(users.email);
      }

      return NextResponse.json(userList);
    }

    // Return all users
    const userList = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.email);

    return NextResponse.json(userList);
  } catch (error) {
    await logError(db, { message: "Failed to fetch users", error, source: "api/admin/users", request });
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
