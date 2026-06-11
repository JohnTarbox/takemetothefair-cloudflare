export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, promoters, vendors } from "@/lib/db/schema";
import { notInArray, isNotNull } from "drizzle-orm";
import { logError } from "@/lib/logger";

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
      // Users who don't already have a promoter profile. Uses a NOT IN
      // (SELECT …) SUBQUERY rather than fetching the ids and binding them via
      // notInArray(col, idArray): the array form blows D1's ~100 bound-variable
      // limit once enough promoters exist (D1_ERROR "too many SQL variables" —
      // the crash that took down /admin/promoters/new on 2026-06-11). The
      // subquery filters NULL userIds so the NOT IN doesn't go empty on a NULL
      // (SQL three-valued logic).
      const userList = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(
          notInArray(
            users.id,
            db.select({ userId: promoters.userId }).from(promoters).where(isNotNull(promoters.userId))
          )
        )
        .orderBy(users.email);

      return NextResponse.json(userList);
    }

    if (available === "vendor") {
      // Users without a vendor profile — same subquery fix as the promoter
      // branch (the array form would hit the D1 variable cap as vendors grow).
      const userList = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(
          notInArray(
            users.id,
            db.select({ userId: vendors.userId }).from(vendors).where(isNotNull(vendors.userId))
          )
        )
        .orderBy(users.email);

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
    await logError(db, {
      message: "Failed to fetch users",
      error,
      source: "api/admin/users",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
