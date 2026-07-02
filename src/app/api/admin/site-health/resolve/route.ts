export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthorizedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { resolveIssue } from "@/lib/site-health";

const bodySchema = z.object({
  fingerprint: z.string().min(8).max(128),
});

export async function POST(request: Request) {
  const authz = await getAuthorizedSession(request);
  if (!authz.authorized) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "invalid_payload", message: parsed.error.message },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();
  await resolveIssue(db, parsed.data.fingerprint);

  return NextResponse.json({
    success: true,
    data: {
      fingerprint: parsed.data.fingerprint,
      resolvedAt: Math.floor(Date.now() / 1000),
    },
  });
}
