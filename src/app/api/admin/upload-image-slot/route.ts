export const dynamic = "force-dynamic";
/**
 * K17 (2026-06-07): mint a one-shot upload slot.
 *
 * Returns a signed slot token + URL that the caller (Claude Desktop, a
 * curl smoke test, or any HTTPS client) can POST raw image bytes to. The
 * paired endpoint /api/admin/upload-image-direct/[token] consumes the
 * slot and runs the standard Phase 2a/2b pipeline.
 *
 * Why a separate slot endpoint instead of POSTing bytes directly through
 * an MCP tool:
 *   - upload_image_bytes already exists; it accepts base64 in the tool
 *     argument. The constraint Claude Desktop hit (per K17 in
 *     Dev-Email-2026-06-07.md) is that the Claude model can't reliably
 *     emit ~500KB of base64 in a tool-call argument.
 *   - This endpoint moves the byte transport off the MCP channel: the
 *     model only needs to emit the slot's MCP tool name + a tiny args
 *     payload; the bytes go straight from Claude Desktop's HTTP client
 *     to the main app over TLS.
 *
 * Auth: admin session OR X-Internal-Key (the MCP server calls this with
 * X-Internal-Key when the request_image_upload_slot MCP tool fires).
 *
 * Slot lifetime: 5 minutes (src/lib/upload-slot-token.ts SLOT_TTL_SECONDS).
 * Replay protection: one-shot via KV.delete on consume.
 */

import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { events, vendors, venues, promoters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import {
  PIPELINE_ALLOWED_TYPES,
  PIPELINE_MAX_BYTES,
  type PipelineTargetType,
} from "@/lib/upload-image-pipeline";
import { issueUploadSlot, type UploadImageRole } from "@/lib/upload-slot-token";

interface SlotRequestBody {
  target_type?: string;
  target_id?: string;
  image_role?: string | null;
  caption?: string | null;
}

async function authorize(
  request: NextRequest
): Promise<{ ok: true; actorId: string } | { ok: false; status: number }> {
  // WS3b — constant-time X-Internal-Key check via the shared helper (was a
  // timing-unsafe `===`).
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
  const authResult = await authorize(request);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.status });
  }
  const { actorId } = authResult;

  const db = getCloudflareDb();

  let body: SlotRequestBody;
  try {
    body = (await request.json()) as SlotRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const targetType = body.target_type as PipelineTargetType | undefined;
  const targetId = body.target_id;
  const caption = typeof body.caption === "string" ? body.caption.slice(0, 200) : null;
  // Image slot fixed into the token at mint time. OPE-33 — promoter logo-vs-hero;
  // OPE-212/OPE-254 — "gallery" appends an event_photos/vendor_photos row instead
  // of overwriting the hero. Mirror upload-image-bytes' role parse: anything not
  // "hero"/"gallery" falls back to "logo". (The prior code dropped "gallery" here,
  // silently coercing a gallery upload into a hero/logo overwrite.)
  const imageRole: UploadImageRole =
    body.image_role === "hero" ? "hero" : body.image_role === "gallery" ? "gallery" : "logo";

  if (!targetType || !["event", "vendor", "venue", "promoter"].includes(targetType)) {
    return NextResponse.json(
      { error: "Missing or invalid 'target_type' (must be event / vendor / venue / promoter)" },
      { status: 400 }
    );
  }
  if (!targetId || typeof targetId !== "string") {
    return NextResponse.json({ error: "Missing 'target_id'" }, { status: 400 });
  }

  // Verify the target row exists so we don't issue slots for ghosts.
  let targetExists = false;
  if (targetType === "event") {
    const rows = await db.select({ id: events.id }).from(events).where(eq(events.id, targetId));
    targetExists = rows.length > 0;
  } else if (targetType === "vendor") {
    const rows = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, targetId));
    targetExists = rows.length > 0;
  } else if (targetType === "promoter") {
    const rows = await db
      .select({ id: promoters.id })
      .from(promoters)
      .where(eq(promoters.id, targetId));
    targetExists = rows.length > 0;
  } else {
    const rows = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, targetId));
    targetExists = rows.length > 0;
  }
  if (!targetExists) {
    return NextResponse.json({ error: `${targetType} not found: ${targetId}` }, { status: 404 });
  }

  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    await logError(db, {
      message: "upload-image-slot: RATE_LIMIT_KV not bound",
      source: "admin-upload-image-slot",
      context: { targetType, targetId },
    });
    return NextResponse.json(
      { error: "Upload-slot KV not configured on this environment" },
      { status: 500 }
    );
  }

  const slot = await issueUploadSlot(kv, {
    targetType,
    targetId,
    imageRole,
    issuedBy: actorId,
    caption,
    maxBytes: PIPELINE_MAX_BYTES,
  });

  const origin = new URL(request.url).origin;
  const upload_url = `${origin}/api/admin/upload-image-direct/${slot.token}`;

  return NextResponse.json({
    upload_url,
    expires_at: slot.expiresAt.toISOString(),
    max_bytes: slot.maxBytes,
    allowed_types: Array.from(PIPELINE_ALLOWED_TYPES),
    target_type: targetType,
    target_id: targetId,
    instructions: [
      `POST raw image bytes (or multipart with field 'file') to upload_url`,
      `before expires_at. Allowed Content-Type values: ${Array.from(PIPELINE_ALLOWED_TYPES).join(", ")}.`,
      `Max file size: ${(slot.maxBytes / 1024 / 1024).toFixed(0)} MB.`,
      `The URL is one-shot — consumed on first successful POST.`,
    ].join(" "),
  });
}
