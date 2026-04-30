import { NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { pingIndexNow } from "@/lib/indexnow";

export const runtime = "edge";

// `source` is optional and free-form so callers can label the lifecycle event
// (e.g. "event-approve", "vendor-create"). Falls back to "internal-api" for
// legacy callers that don't set one.
const bodySchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10_000),
  source: z.string().min(1).max(64).optional(),
});

/**
 * POST /api/internal/indexnow
 * Internal endpoint for the MCP server (and other Workers) to trigger an
 * IndexNow ping. Auth: X-Internal-Key header.
 *
 * Fire-and-forget — does not wait for the IndexNow response. The caller can
 * return its own success even if the ping fails (errors are logged).
 */
export async function POST(request: Request) {
  const env = getCloudflareEnv() as unknown as {
    INTERNAL_API_KEY?: string;
    INDEXNOW_KEY?: string;
  };

  const internalKey = request.headers.get("X-Internal-Key");
  if (!internalKey || internalKey !== env.INTERNAL_API_KEY) {
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
    return NextResponse.json({ success: false, error: "invalid_payload" }, { status: 400 });
  }

  const db = getCloudflareDb();
  await pingIndexNow(db, parsed.data.urls, env, parsed.data.source ?? "internal-api");
  return NextResponse.json({ success: true, count: parsed.data.urls.length });
}
