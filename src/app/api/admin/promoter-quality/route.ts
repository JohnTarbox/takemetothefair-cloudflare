export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { respondWithPromoterQuality } from "@/lib/admin-list/promoter-quality";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  try {
    return await respondWithPromoterQuality(db, request.nextUrl.searchParams);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch promoter quality",
      error,
      source: "api/admin/promoter-quality",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch promoter quality" }, { status: 500 });
  }
});
