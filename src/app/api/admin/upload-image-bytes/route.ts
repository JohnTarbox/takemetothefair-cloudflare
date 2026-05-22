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
 * Phase 2a (analyst 2026-05-22 P5a):
 *   - EXIF/XMP/IPTC strip for JPEG uploads. Eliminates the GPS-coordinate
 *     leak for phone photos before any byte hits the public CDN — the
 *     highest-stakes piece of the analyst's spec.
 *
 * Phase 2b (this commit, analyst 2026-05-22):
 *   - Auto-orient + resize-to-2000px-longest-edge + re-encode to WebP q85
 *     via Cloudflare Image Resizing (`cf: { image: {...} }`). Requires
 *     Image Resizing enabled on the meetmeatthefair.com zone. The
 *     transform is best-effort: on failure (zone not enabled, transform
 *     timeout, etc.) we keep the Phase-2a-stripped original at the
 *     original-extension key — i.e., worst case is identical to Phase 2a
 *     behavior alone. No data migration needed for rollback.
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
import {
  stripExifFromJpeg,
  transformViaCloudflare,
  ImageTransformError,
  SOFT_SIZE_LIMIT_BYTES,
} from "@/lib/image-optim";

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
  let bytes = new Uint8Array(await file.arrayBuffer());
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

  // Phase 2a EXIF strip (analyst 2026-05-22 P5a). JPEGs from phones embed
  // GPS coordinates by default; the strip happens BEFORE the R2 put so the
  // bytes that land on the public CDN can't contain location history.
  // Non-JPEG content types pass through unchanged (PNG/WebP/SVG metadata
  // handling is Phase 2b territory).
  let bytesRemovedByExifStrip = 0;
  let exifSegmentsStripped = 0;
  if (declaredType === "image/jpeg" || declaredType === "image/jpg") {
    const stripResult = stripExifFromJpeg(bytes);
    // stripResult.bytes is Uint8Array<ArrayBufferLike> (general); wrap in a
    // fresh ArrayBuffer-backed view so the inferred type matches R2's
    // strict Uint8Array<ArrayBuffer> input.
    const stripped = new Uint8Array(stripResult.bytes.length);
    stripped.set(stripResult.bytes);
    bytes = stripped;
    bytesRemovedByExifStrip = stripResult.bytesRemoved;
    exifSegmentsStripped = stripResult.segmentsStripped;
  }
  // (over-soft-budget is computed in the response payload below against
  // `finalBytesCount`, which reflects either the Phase-2b transform output
  // or the Phase-2a fallback — both honest values.)

  // Key layout mirrors the per-entity routes. Includes target_type so we
  // can find/clean up later regardless of which endpoint wrote the bytes.
  // `baseKey` is the prefix shared between the originalKey (used for the
  // Phase-2b staging round-trip) and the eventual webpKey (if the
  // transform succeeds).
  const keyPrefix =
    targetType === "event" ? "events" : targetType === "vendor" ? "vendors" : "venues";
  const fileKind = targetType === "vendor" ? "logo" : "image";
  const timestamp = Date.now();
  const baseKey = `${keyPrefix}/${targetId}/${fileKind}-${timestamp}`;
  const originalKey = `${baseKey}.${ext}`;

  // First R2 put: the Phase-2a-stripped original. This is also the source
  // URL that Cloudflare Image Resizing fetches from for the Phase-2b
  // transform — Image Resizing needs a public-fetchable URL.
  try {
    await bucket.put(originalKey, bytes, {
      httpMetadata: { contentType: declaredType },
      customMetadata: {
        uploadedBy: actorId,
        originalName: file.name,
        caption: caption ?? "",
        source: "upload_image_bytes",
        // Marker BEFORE transform attempt; rewritten on the webp key if
        // the transform succeeds.
        optimization:
          bytesRemovedByExifStrip > 0
            ? `phase-2a:exif-strip,bytes_removed=${bytesRemovedByExifStrip}`
            : "phase-2a:none",
      },
    });
  } catch (e) {
    await logError(db, {
      message: "upload-image-bytes: R2 put (original) failed",
      error: e,
      source: "admin-upload-image-bytes",
      context: { key: originalKey, targetType, targetId },
    });
    return NextResponse.json({ error: "Upload failed" }, { status: 502 });
  }

  // ── Phase 2b transform pipeline ──────────────────────────────────
  // Skip when:
  //   - input is SVG (vector — transform would rasterize)
  //   - input is already small (< 50 KB — typically already optimized)
  // Otherwise fetch the just-stored URL with cf.image and re-put the
  // WebP body at a sibling key. Cloudflare's Image Resizing applies
  // EXIF Orientation, scale-down to 2000px longest edge, and WebP q85
  // re-encoding in a single transform.
  const PHASE2B_SKIP_BELOW_BYTES = 50 * 1024;
  const skipPhase2bReason: string | null =
    declaredType === "image/svg+xml"
      ? "svg-not-rasterized"
      : bytes.length < PHASE2B_SKIP_BELOW_BYTES
        ? "small-input"
        : null;

  let finalKey = originalKey;
  let finalContentType: string = declaredType;
  let finalBytesCount = bytes.length;
  let phase2bStatus: "applied" | "skipped" | "fallback" = skipPhase2bReason ? "skipped" : "applied";
  const phase2bSkipReason: string | null = skipPhase2bReason;
  let phase2bWidth: number | null = null;
  let phase2bHeight: number | null = null;
  let phase2bDurationMs: number | null = null;
  let phase2bErrorDetail: string | null = null;

  if (!skipPhase2bReason) {
    try {
      const originalUrl = `${CDN_BASE}/${originalKey}`;
      const transform = await transformViaCloudflare(originalUrl);

      // Second R2 put: the WebP output at a sibling key. Use the same
      // timestamp so the two assets sort together; the .webp extension
      // is what the DB column ends up pointing at.
      const webpKey = `${baseKey}.webp`;
      await bucket.put(webpKey, transform.bytes, {
        httpMetadata: { contentType: "image/webp" },
        customMetadata: {
          uploadedBy: actorId,
          originalName: file.name,
          caption: caption ?? "",
          source: "upload_image_bytes",
          optimization: `phase-2b:cf-image,original_bytes=${transform.originalBytes},final_bytes=${transform.finalBytes},width=${transform.width ?? ""},height=${transform.height ?? ""}`,
        },
      });

      // Delete the original-extension copy. Best-effort: an orphan
      // doesn't break anything user-facing (the DB points at the
      // .webp key) but burns R2 storage if we never cleaned up.
      try {
        await bucket.delete(originalKey);
      } catch (delErr) {
        await logError(db, {
          level: "warn",
          message: "upload-image-bytes: Phase 2b cleanup delete failed (non-fatal)",
          error: delErr,
          source: "admin-upload-image-bytes",
          context: { originalKey, targetType, targetId },
        });
      }

      finalKey = webpKey;
      finalContentType = "image/webp";
      finalBytesCount = transform.finalBytes;
      phase2bWidth = transform.width;
      phase2bHeight = transform.height;
      phase2bDurationMs = transform.durationMs;
    } catch (e) {
      // Fallback path: the original-extension R2 object stays, the DB
      // gets that URL. Worst case is "Phase 2a behavior only" — exactly
      // what would have shipped if Phase 2b didn't exist.
      phase2bStatus = "fallback";
      if (e instanceof ImageTransformError) {
        phase2bErrorDetail = `status=${e.status} ${e.detail.slice(0, 200)}`;
      } else {
        phase2bErrorDetail = e instanceof Error ? e.message : String(e);
      }
      await logError(db, {
        level: "warn",
        message: "upload-image-bytes: Phase 2b transform failed; falling back to original bytes",
        error: e,
        source: "admin-upload-image-bytes",
        context: { originalKey, targetType, targetId },
      });
    }
  }

  const url = `${CDN_BASE}/${finalKey}`;

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
      context: { key: finalKey, targetType, targetId },
    });
    return NextResponse.json(
      { error: "Uploaded but DB update failed; paste URL manually", url, key: finalKey },
      { status: 502 }
    );
  }

  const compressionRatio =
    phase2bStatus === "applied" && bytes.length > 0
      ? Number((finalBytesCount / bytes.length).toFixed(3))
      : null;

  return NextResponse.json({
    url,
    key: finalKey,
    content_type: finalContentType,
    target_type: targetType,
    target_id: targetId,
    image_column: imageColumn,
    bytes_stored: finalBytesCount,
    bytes_removed_by_exif_strip: bytesRemovedByExifStrip,
    exif_segments_stripped: exifSegmentsStripped,
    over_soft_budget: finalBytesCount > SOFT_SIZE_LIMIT_BYTES,
    soft_size_limit_bytes: SOFT_SIZE_LIMIT_BYTES,
    optimization: "phase-2b",
    phase2b: {
      status: phase2bStatus,
      skip_reason: phase2bSkipReason,
      error_detail: phase2bErrorDetail,
      width: phase2bWidth,
      height: phase2bHeight,
      duration_ms: phase2bDurationMs,
      compression_ratio: compressionRatio,
    },
  });
}
