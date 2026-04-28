import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getAuthorizedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { snoozeIssue } from "@/lib/site-health";

export const runtime = "edge";

const bodySchema = z.object({
  fingerprint: z.string().min(8).max(128),
  days: z.number().int().min(1).max(365),
  note: z.string().max(500).optional(),
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

  // Capture the actual user id when available; fall back to "internal" for
  // X-Internal-Key callers (the MCP server).
  const session = await auth();
  const userId = authz.userId ?? session?.user?.id ?? "internal";

  const db = getCloudflareDb();
  await snoozeIssue(db, parsed.data.fingerprint, parsed.data.days, userId, parsed.data.note);

  return NextResponse.json({
    success: true,
    data: {
      fingerprint: parsed.data.fingerprint,
      snoozedUntil: Math.floor(Date.now() / 1000) + parsed.data.days * 86400,
    },
  });
}
