/**
 * Generic image upload endpoint accepting base64 bytes (NOT a URL).
 * Mirrors src/app/api/admin/events/[id]/upload-image/route.ts but works
 * for any target type: event / vendor / venue. Caller picks the target
 * via the `target_type` + `target_id` form fields.
 *
 * Why a separate endpoint vs reusing the per-entity upload routes:
 *   - The per-entity routes accept multipart FormData with field "file" —
 *     that's a fine UX from a browser form, but the MCP tool already has
 *     base64 bytes in hand (analyst spec, 2026-05-16). Adapting bytes
 *     into FormData on every MCP call works but adds boundary-encoding
 *     overhead and an extra fetch hop.
 *   - The MCP server fetches base64 bytes from the caller's payload
 *     and forwards them here as multipart. The bytes round-trip through
 *     a Blob without an external URL fetch (existing upload_event_image
 *     requires the source image to already be on a public URL — that's
 *     the gap the new tool closes).
 *
 * Phase 1 scope (this commit):
 *   - 10MB input cap (analyst spec); validates magic bytes match the
 *     declared content_type so an SVG can't masquerade as a JPEG.
 *   - Writes raw bytes to R2 with target-aware key prefix.
 *   - Updates the target row's image column.
 *
 * Phase 2 (deferred):
 *   - Server-side optimization pipeline (auto-orient + EXIF strip +
 *     resize 2000px + WebP q85, soft 800KB / hard 2MB step-down). The
 *     analyst's spec mandates this but doesn't specify the runtime;
 *     Pages + WASM image-processing libraries (@cf-wasm/photon,
 *     imagescript) need a research spike first. Filed as follow-up.
 *
 * Auth: admin session OR X-Internal-Key (mirrors existing upload routes).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, vendors, venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";

export const runtime = "edge";

// Per analyst spec 2026-05-16: 10MB input cap allows raw phone/DSLR photos
// (the existing 5MB cap rejected most modern iPhone JPEGs out of hand).
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

const CDN_BASE = "https://cdn.meetmeatthefair.com";

type TargetType = "event" | "vendor" | "venue";

function extensionFor(contentType: string): string | null {
  switch (contentType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

/** Magic-byte sniff. Returns the detected content type or null if the
 *  bytes don't match any allowed image format. Catches the
 *  declared-jpeg-but-actually-SVG attack the analyst's spec called out. */
function detectMagicBytes(buf: Uint8Array): string | null {
  if (buf.length < 4) return null;
  // JPEG: starts with 0xFF 0xD8 0xFF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // WebP: "RIFF....WEBP" — check 0..3 + 8..11
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  // SVG: heuristic — first non-whitespace bytes "<svg" or "<?xml" followed
  // by an "<svg" later. Conservative: require the first non-whitespace
  // char to be '<'.
  let i = 0;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)
  ) {
    i++;
  }
  if (buf[i] === 0x3c /* '<' */) {
    // Check the next few bytes for "svg" or "?xml" (xml prolog followed by svg later)
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      buf.slice(i, Math.min(i + 256, buf.length))
    );
    if (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head)) return "image/svg+xml";
    if (/^<svg[\s>]/i.test(head)) return "image/svg+xml";
  }
  return null;
}

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<{ ok: true; actorId: string } | { ok: false; status: number }> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return { ok: true, actorId: "mcp-server" };
  }
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { ok: true, actorId: session.user.id };
  }
  return { ok: false, status: 401 };
}

export async function POST(request: NextRequest) {
  const env = getCloudflareEnv() as unknown as {
    INTERNAL_API_KEY?: string;
    VENDOR_ASSETS?: R2Bucket;
  };

  const authResult = await authorize(request, env);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.status });
  }
  const { actorId } = authResult;

  const db = getCloudflareDb();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e) {
    await logError(db, {
      message: "upload-image-bytes: invalid multipart body",
      error: e,
      source: "admin-upload-image-bytes",
    });
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  const targetType = formData.get("target_type") as TargetType | null;
  const targetId = formData.get("target_id") as string | null;
  const caption = (formData.get("caption") as string | null) || null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }
  if (!targetType || !["event", "vendor", "venue"].includes(targetType)) {
    return NextResponse.json(
      { error: "Missing or invalid 'target_type' (must be event / vendor / venue)" },
      { status: 400 }
    );
  }
  if (!targetId) {
    return NextResponse.json({ error: "Missing 'target_id'" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(2)} MB exceeds the ${
          MAX_BYTES / 1024 / 1024
        } MB cap.`,
      },
      { status: 413 }
    );
  }

  const declaredType = file.type || "application/octet-stream";
  if (!ALLOWED_TYPES.has(declaredType)) {
    return NextResponse.json(
      { error: `Unsupported content_type "${declaredType}". Allowed: jpg/png/webp/svg.` },
      { status: 400 }
    );
  }

  // Verify target row exists before doing the R2 put.
  let targetExists = false;
  let imageColumn: "imageUrl" | "logoUrl";
  if (targetType === "event") {
    const rows = await db.select({ id: events.id }).from(events).where(eq(events.id, targetId));
    targetExists = rows.length > 0;
    imageColumn = "imageUrl";
  } else if (targetType === "vendor") {
    const rows = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, targetId));
    targetExists = rows.length > 0;
    imageColumn = "logoUrl";
  } else {
    const rows = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, targetId));
    targetExists = rows.length > 0;
    imageColumn = "imageUrl";
  }
  if (!targetExists) {
    return NextResponse.json({ error: `${targetType} not found: ${targetId}` }, { status: 404 });
  }

  // Magic-byte sniff. Bail before R2 if the declared content_type doesn't
  // match the actual bytes — analyst spec's "<svg> claiming image/jpeg"
  // test case.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectMagicBytes(bytes);
  if (!detected) {
    return NextResponse.json(
      { error: "File bytes don't match any supported image format" },
      { status: 400 }
    );
  }
  // Allow image/jpg <=> image/jpeg equivalence; otherwise types must match.
  const norm = (t: string) => (t === "image/jpg" ? "image/jpeg" : t);
  if (norm(detected) !== norm(declaredType)) {
    return NextResponse.json(
      {
        error: `Content-type mismatch: declared "${declaredType}" but bytes look like "${detected}".`,
      },
      { status: 400 }
    );
  }

  const ext = extensionFor(declaredType);
  if (!ext) {
    return NextResponse.json({ error: "Unsupported content_type" }, { status: 400 });
  }

  const bucket = env.VENDOR_ASSETS;
  if (!bucket) {
    return NextResponse.json(
      { error: "R2 bucket not bound (VENDOR_ASSETS missing)" },
      { status: 500 }
    );
  }

  // Key layout mirrors the per-entity routes. Includes target_type so we
  // can find/clean up later regardless of which endpoint wrote the bytes.
  const keyPrefix =
    targetType === "event" ? "events" : targetType === "vendor" ? "vendors" : "venues";
  const fileKind = targetType === "vendor" ? "logo" : "image";
  const key = `${keyPrefix}/${targetId}/${fileKind}-${Date.now()}.${ext}`;

  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: declaredType },
      customMetadata: {
        uploadedBy: actorId,
        originalName: file.name,
        caption: caption ?? "",
        source: "upload_image_bytes",
        // Phase 1: no optimization. Phase 2 will overwrite or post-process.
        optimization: "none",
      },
    });
  } catch (e) {
    await logError(db, {
      message: "upload-image-bytes: R2 put failed",
      error: e,
      source: "admin-upload-image-bytes",
      context: { key, targetType, targetId },
    });
    return NextResponse.json({ error: "Upload failed" }, { status: 502 });
  }

  const url = `${CDN_BASE}/${key}`;

  try {
    if (targetType === "event") {
      await db.update(events).set({ imageUrl: url }).where(eq(events.id, targetId));
      await recomputeEventCompleteness(db, targetId);
    } else if (targetType === "vendor") {
      await db.update(vendors).set({ logoUrl: url }).where(eq(vendors.id, targetId));
    } else {
      await db.update(venues).set({ imageUrl: url }).where(eq(venues.id, targetId));
    }
  } catch (e) {
    await logError(db, {
      message: "upload-image-bytes: DB update failed (R2 has the file)",
      error: e,
      source: "admin-upload-image-bytes",
      context: { key, targetType, targetId },
    });
    return NextResponse.json(
      { error: "Uploaded but DB update failed; paste URL manually", url, key },
      { status: 502 }
    );
  }

  return NextResponse.json({
    url,
    key,
    target_type: targetType,
    target_id: targetId,
    image_column: imageColumn,
    bytes_stored: bytes.length,
    optimization: "none_phase_1",
  });
}
