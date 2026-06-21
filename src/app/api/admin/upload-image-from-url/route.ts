export const dynamic = "force-dynamic";
/**
 * K30 (2026-06-21) — re-host an image from a public URL onto
 * cdn.meetmeatthefair.com for any target type (event / vendor / venue).
 *
 * Sibling of /api/admin/upload-image-bytes: that one takes raw bytes (the
 * caller already holds them), this one takes a URL and fetches it SERVER-SIDE
 * so the bytes never round-trip through the MCP channel (no ~100KB base64-in-
 * tool-arg ceiling). Both delegate to the same runUploadPipeline, so the URL
 * path gets the identical EXIF strip + auto-orient + resize + WebP convert
 * optimization, and writes the same image column (vendors.logo_url /
 * venues.image_url / events.image_url).
 *
 * The fetch lives here (not in the MCP Worker) so the shared, unit-tested SSRF
 * guard runs on the main app before any outbound request — the existing
 * upload_event_image MCP tool fetches in the Worker with NO SSRF check; K30
 * closes that gap for the new vendor/venue tools.
 *
 * Auth: admin session OR X-Internal-Key (MCP path). JSON body:
 *   { image_url: string, target_type: "event"|"vendor"|"venue", target_id: string, caption?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, vendors, venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { isBlockedSsrfHost } from "@takemetothefair/site-fetch";
import {
  runUploadPipeline,
  PIPELINE_ALLOWED_TYPES,
  PIPELINE_MAX_BYTES,
  type PipelineTargetType,
} from "@/lib/upload-image-pipeline";

// 15s fetch cap: Workers have a 30s budget; 15s for the source fetch leaves
// headroom for the R2 put + Phase-2b Cloudflare Image transform downstream.
const FETCH_TIMEOUT_MS = 15_000;

async function authorize(
  request: NextRequest
): Promise<{ ok: true; actorId: string } | { ok: false; status: number }> {
  if (await internalKeyMatches(request)) {
    return { ok: true, actorId: "mcp-server" };
  }
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { ok: true, actorId: session.user.id };
  }
  return { ok: false, status: 401 };
}

export async function POST(request: NextRequest) {
  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };

  const authResult = await authorize(request);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.status });
  }
  const { actorId } = authResult;

  const db = getCloudflareDb();

  let body: {
    image_url?: unknown;
    target_type?: unknown;
    target_id?: unknown;
    caption?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const imageUrl = typeof body.image_url === "string" ? body.image_url : "";
  const targetType = body.target_type as PipelineTargetType | undefined;
  const targetId = typeof body.target_id === "string" ? body.target_id : "";
  const caption = typeof body.caption === "string" ? body.caption : null;

  if (!targetType || !["event", "vendor", "venue"].includes(targetType)) {
    return NextResponse.json(
      { error: "Missing or invalid 'target_type' (must be event / vendor / venue)" },
      { status: 400 }
    );
  }
  if (!targetId) {
    return NextResponse.json({ error: "Missing 'target_id'" }, { status: 400 });
  }

  // Validate + SSRF-guard the URL before any outbound request.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: "Invalid image_url" }, { status: 400 });
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return NextResponse.json({ error: "image_url must be http(s)" }, { status: 400 });
  }
  if (isBlockedSsrfHost(parsedUrl.hostname)) {
    return NextResponse.json({ error: "Internal URLs are not allowed" }, { status: 400 });
  }

  // Verify the target row exists before fetching/putting.
  let targetExists = false;
  if (targetType === "event") {
    const rows = await db.select({ id: events.id }).from(events).where(eq(events.id, targetId));
    targetExists = rows.length > 0;
  } else if (targetType === "vendor") {
    const rows = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, targetId));
    targetExists = rows.length > 0;
  } else {
    const rows = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, targetId));
    targetExists = rows.length > 0;
  }
  if (!targetExists) {
    return NextResponse.json({ error: `${targetType} not found: ${targetId}` }, { status: 404 });
  }

  // Fetch the source image. A plausible UA materially improves hit rate on CDN
  // hosts that reject the default Workers UA.
  let imageResponse: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    imageResponse = await fetch(parsedUrl.href, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MMATFBot/1.0)" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
  } catch (e) {
    await logError(db, {
      message: "upload-image-from-url: source fetch failed",
      error: e,
      source: "admin-upload-image-from-url",
      context: { imageUrl, targetType, targetId },
    });
    return NextResponse.json(
      { error: "Failed to fetch source image — verify the URL is publicly accessible." },
      { status: 502 }
    );
  }
  if (!imageResponse.ok) {
    return NextResponse.json(
      { error: `Source image fetch returned HTTP ${imageResponse.status}.` },
      { status: 502 }
    );
  }

  const declaredType = (imageResponse.headers.get("Content-Type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!PIPELINE_ALLOWED_TYPES.has(declaredType)) {
    return NextResponse.json(
      {
        error: `Unsupported content_type "${declaredType || "unknown"}". Allowed: jpg/png/webp/svg.`,
      },
      { status: 400 }
    );
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    return NextResponse.json({ error: "Source image is empty" }, { status: 400 });
  }
  if (arrayBuffer.byteLength > PIPELINE_MAX_BYTES) {
    return NextResponse.json(
      {
        error: `Source image is ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB exceeds the ${
          PIPELINE_MAX_BYTES / 1024 / 1024
        } MB cap.`,
      },
      { status: 413 }
    );
  }

  const fileName = (() => {
    try {
      const last = parsedUrl.pathname.split("/").filter(Boolean).pop() ?? "source-image";
      return last.length > 100 ? "source-image" : last;
    } catch {
      return "source-image";
    }
  })();

  const result = await runUploadPipeline({
    bytes: new Uint8Array(arrayBuffer),
    declaredType,
    fileName,
    targetType,
    targetId,
    caption,
    actorId,
    uploadSource: "upload_image_from_url",
    db,
    env,
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json({ ...result.body, source_url: parsedUrl.href });
}
