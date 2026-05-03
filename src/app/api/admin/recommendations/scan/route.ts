import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAuthorizedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { scanAll } from "@/lib/recommendations/engine";
import { ALL_RULES } from "@/lib/recommendations/rules";

export const runtime = "edge";

export async function POST(request: Request) {
  const authz = await getAuthorizedSession(request);
  if (!authz.authorized) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const session = await auth();
  if (session && session.user.role !== "ADMIN" && !authz.userId) {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 });
  }

  const db = getCloudflareDb();
  const result = await scanAll(db, ALL_RULES);
  return NextResponse.json({ success: true, data: result });
}
