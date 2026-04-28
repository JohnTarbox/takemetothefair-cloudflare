import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { unsnoozeIssue } from "@/lib/site-health";

export const runtime = "edge";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ fingerprint: string }> }
) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const { fingerprint } = await params;
  if (!fingerprint || fingerprint.length < 8) {
    return NextResponse.json({ success: false, error: "invalid_payload" }, { status: 400 });
  }
  const db = getCloudflareDb();
  await unsnoozeIssue(db, fingerprint);
  return NextResponse.json({ success: true });
}
