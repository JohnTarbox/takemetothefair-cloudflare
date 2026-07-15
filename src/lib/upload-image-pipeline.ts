/**
 * K17 (2026-06-07): the shared image-upload pipeline, extracted from
 * src/app/api/admin/upload-image-bytes/route.ts so the new
 * /api/admin/upload-image-direct/[token] endpoint can reuse it without
 * duplication.
 *
 * The split point is the same as the original handler's: after multipart
 * + auth + target validation, before the Phase 2a EXIF strip. The pipeline
 * accepts already-validated inputs and runs the deterministic post-
 * processing:
 *
 *   1. magic-byte sniff (declared content_type vs actual bytes)
 *   2. R2 put of the original (Phase 2a EXIF-stripped if JPEG)
 *   3. Phase 2b Cloudflare Image Resizing transform → WebP, second R2 put,
 *      delete the original sibling (best-effort)
 *   4. DB write of the new URL to the target row's image column
 *   5. response payload assembly
 *
 * The pre-pipeline checks (auth, target existence, declared content_type
 * allowlist, file size cap) stay in the route handlers because their error
 * shapes are HTTP-specific and the two endpoints have different auth
 * surfaces (admin session + INTERNAL_API_KEY vs slot token).
 *
 * Behavior parity with the pre-refactor route is the explicit goal: same
 * R2 keys, same DB columns updated, same response payload shape. Unit
 * tests at __tests__/upload-image-pipeline.test.ts pin the magic-byte
 * branch; the integration shape is exercised in prod by the existing
 * upload_image_bytes MCP tool.
 */

import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import * as schema from "@/lib/db/schema";
import { events, vendors, venues, promoters, vendorPhotos } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";
import {
  stripExifFromJpeg,
  transformViaCloudflare,
  ImageTransformError,
  SOFT_SIZE_LIMIT_BYTES,
} from "@/lib/image-optim";

// Matches the wider Db type other lib modules use (src/lib/completeness.ts
// derives it via `ReturnType<typeof getCloudflareDb>`). The `$client`
// field is added by drizzle's d1 factory and is part of the runtime
// shape `recomputeEventCompleteness` and friends expect.
type Db = DrizzleD1Database<typeof schema> & { $client: D1Database };

export const CDN_BASE = "https://cdn.meetmeatthefair.com";

export const PIPELINE_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

export const PIPELINE_MAX_BYTES = 10 * 1024 * 1024;
const PHASE2B_SKIP_BELOW_BYTES = 50 * 1024;

export type PipelineTargetType = "event" | "vendor" | "venue" | "promoter";

/**
 * Which image slot an upload targets.
 *
 * OPE-33/OPE-34 — "logo" / "hero" select a promoter COLUMN (`promoters.logo_url`
 * vs `hero_image_url`); other targets have one image column each and ignore it.
 *
 * OPE-211 — "gallery" is different in kind: it APPENDS a `vendor_photos` row
 * instead of overwriting a scalar column. Every role before it was
 * last-write-wins by design, which is exactly why vendors could never have more
 * than one picture. Only `target_type: "vendor"` accepts it today; OPE-212 adds
 * `event` when `event_photos` lands.
 */
export type PipelineImageRole = "logo" | "hero" | "gallery";

export interface PipelineEnv {
  VENDOR_ASSETS?: R2Bucket;
}

/** Where an upload lands: which column (if any), and the R2 key shape. */
export interface ImageTarget {
  /** Append a `vendor_photos` row instead of setting a scalar column. */
  isGallery: boolean;
  /** null for a gallery upload — there is no column to set. */
  imageColumn: "imageUrl" | "logoUrl" | "heroImageUrl" | null;
  /** R2 key = `${keyPrefix}/${targetId}/${fileKind}-${timestamp}.${ext}` */
  keyPrefix: string;
  fileKind: string;
}

/**
 * Resolve (targetType, imageRole) → where the upload lands. Pure, so the
 * dispatch is testable.
 *
 * WHY THIS IS A FUNCTION AND NOT INLINE: this decision is exactly where a
 * mistake is silent and expensive. Every caller before OPE-211 collapsed an
 * unknown role to "logo" (`role === "hero" ? "hero" : "logo"`), so a `gallery`
 * upload would have quietly OVERWRITTEN the vendor's brand logo instead of
 * appending a photo — no error, just a lost logo. `runUploadPipeline` itself is
 * unreachable in unit tests (R2 + D1 + CF Image Resizing), so leaving this
 * inline would leave the one part most worth pinning untested.
 */
export function resolveImageTarget(
  targetType: PipelineTargetType,
  imageRole: PipelineImageRole
): { ok: true; target: ImageTarget } | { ok: false; error: string } {
  const keyPrefix =
    targetType === "event"
      ? "events"
      : targetType === "vendor"
        ? "vendors"
        : targetType === "promoter"
          ? "promoters"
          : "venues";

  if (imageRole === "gallery") {
    // Vendor-only today. OPE-212 adds "event" once event_photos exists — until
    // then an event gallery upload has nowhere to land, so refuse loudly rather
    // than silently clobber events.image_url.
    if (targetType !== "vendor") {
      return {
        ok: false,
        error: `image_role "gallery" is only supported for target_type "vendor" (got "${targetType}")`,
      };
    }
    // Under photos/ so a gallery object can never collide with the single logo.
    return {
      ok: true,
      target: { isGallery: true, imageColumn: null, keyPrefix, fileKind: "photos/photo" },
    };
  }

  // OPE-33 — vendor → logoUrl; promoter → logo_url or hero_image_url per role;
  // event/venue → imageUrl.
  if (targetType === "promoter") {
    const hero = imageRole === "hero";
    return {
      ok: true,
      target: {
        isGallery: false,
        imageColumn: hero ? "heroImageUrl" : "logoUrl",
        keyPrefix,
        fileKind: hero ? "hero" : "logo",
      },
    };
  }
  if (targetType === "vendor") {
    return {
      ok: true,
      target: { isGallery: false, imageColumn: "logoUrl", keyPrefix, fileKind: "logo" },
    };
  }
  return {
    ok: true,
    target: { isGallery: false, imageColumn: "imageUrl", keyPrefix, fileKind: "image" },
  };
}

export interface RunPipelineArgs {
  bytes: Uint8Array;
  declaredType: string;
  fileName: string;
  targetType: PipelineTargetType;
  targetId: string;
  /** OPE-33 — for `target_type: "promoter"`, selects logo_url vs hero_image_url.
   *  Ignored for other targets. Defaults to "logo". */
  imageRole?: PipelineImageRole;
  caption: string | null;
  actorId: string;
  /** Free-text source label written to R2 customMetadata.source so the
   *  bucket inventory can distinguish base64-path uploads from slot-path
   *  uploads. */
  uploadSource: string;
  db: Db;
  env: PipelineEnv;
}

export interface PipelineSuccess {
  ok: true;
  body: PipelineResponseBody;
}

export interface PipelineFailure {
  ok: false;
  status: number;
  body: { error: string; [k: string]: unknown };
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

export interface Phase2bMeta {
  status: "applied" | "skipped" | "fallback";
  skip_reason: string | null;
  error_detail: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  compression_ratio: number | null;
}

export interface PipelineResponseBody {
  url: string;
  key: string;
  content_type: string;
  target_type: PipelineTargetType;
  target_id: string;
  /** null for a gallery upload — it appends a row, it doesn't set a column. */
  image_column: "imageUrl" | "logoUrl" | "heroImageUrl" | null;
  /** OPE-211 — the `vendor_photos.id` created, for gallery uploads only. */
  photo_id?: string;
  bytes_stored: number;
  bytes_removed_by_exif_strip: number;
  exif_segments_stripped: number;
  over_soft_budget: boolean;
  soft_size_limit_bytes: number;
  optimization: "phase-2b";
  phase2b: Phase2bMeta;
}

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
 *  bytes don't match any allowed image format. Catches the declared-jpeg-
 *  but-actually-SVG attack the analyst's spec called out. */
export function detectMagicBytes(buf: Uint8Array): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
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
  // SVG heuristic
  let i = 0;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)
  ) {
    i++;
  }
  if (buf[i] === 0x3c /* '<' */) {
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      buf.slice(i, Math.min(i + 256, buf.length))
    );
    if (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head)) return "image/svg+xml";
    if (/^<svg[\s>]/i.test(head)) return "image/svg+xml";
  }
  return null;
}

/**
 * Run the post-validation upload pipeline. Caller has already verified:
 *   - auth
 *   - target row exists (this re-checks via DB write WHERE clause)
 *   - declared content_type is in the allowlist
 *   - bytes.length is within MAX_BYTES
 *
 * On success returns {ok:true, body} with the response payload. On
 * failure returns {ok:false, status, body} where status is the HTTP
 * status the route should emit. The pipeline never throws — internal
 * errors are caught + logged + returned as PipelineFailure.
 */
export async function runUploadPipeline(args: RunPipelineArgs): Promise<PipelineResult> {
  const imageRole: PipelineImageRole = args.imageRole ?? "logo";
  const { db, env, targetType, targetId, caption, actorId, uploadSource, fileName, declaredType } =
    args;
  let bytes = args.bytes;

  const detected = detectMagicBytes(bytes);
  if (!detected) {
    return {
      ok: false,
      status: 400,
      body: { error: "File bytes don't match any supported image format" },
    };
  }
  const norm = (t: string) => (t === "image/jpg" ? "image/jpeg" : t);
  if (norm(detected) !== norm(declaredType)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Content-type mismatch: declared "${declaredType}" but bytes look like "${detected}".`,
      },
    };
  }

  const ext = extensionFor(declaredType);
  if (!ext) {
    return { ok: false, status: 400, body: { error: "Unsupported content_type" } };
  }

  const bucket = env.VENDOR_ASSETS;
  if (!bucket) {
    return {
      ok: false,
      status: 500,
      body: { error: "R2 bucket not bound (VENDOR_ASSETS missing)" },
    };
  }

  const resolved = resolveImageTarget(targetType, imageRole ?? "logo");
  if (!resolved.ok) {
    return { ok: false, status: 400, body: { error: resolved.error } };
  }
  const { isGallery, imageColumn } = resolved.target;

  // Phase 2a EXIF strip (JPEG only)
  let bytesRemovedByExifStrip = 0;
  let exifSegmentsStripped = 0;
  if (declaredType === "image/jpeg" || declaredType === "image/jpg") {
    const stripResult = stripExifFromJpeg(bytes);
    const stripped = new Uint8Array(stripResult.bytes.length);
    stripped.set(stripResult.bytes);
    bytes = stripped;
    bytesRemovedByExifStrip = stripResult.bytesRemoved;
    exifSegmentsStripped = stripResult.segmentsStripped;
  }

  const { keyPrefix, fileKind } = resolved.target;
  const timestamp = Date.now();
  const baseKey = `${keyPrefix}/${targetId}/${fileKind}-${timestamp}`;
  const originalKey = `${baseKey}.${ext}`;

  try {
    await bucket.put(originalKey, bytes, {
      httpMetadata: { contentType: declaredType },
      customMetadata: {
        uploadedBy: actorId,
        originalName: fileName,
        caption: caption ?? "",
        source: uploadSource,
        optimization:
          bytesRemovedByExifStrip > 0
            ? `phase-2a:exif-strip,bytes_removed=${bytesRemovedByExifStrip}`
            : "phase-2a:none",
      },
    });
  } catch (e) {
    await logError(db, {
      message: "upload-image-pipeline: R2 put (original) failed",
      error: e,
      source: "upload-image-pipeline",
      context: { key: originalKey, targetType, targetId, uploadSource },
    });
    return { ok: false, status: 502, body: { error: "Upload failed" } };
  }

  // Phase 2b: Cloudflare Image Resizing transform
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

      const webpKey = `${baseKey}.webp`;
      await bucket.put(webpKey, transform.bytes, {
        httpMetadata: { contentType: "image/webp" },
        customMetadata: {
          uploadedBy: actorId,
          originalName: fileName,
          caption: caption ?? "",
          source: uploadSource,
          optimization: `phase-2b:cf-image,original_bytes=${transform.originalBytes},final_bytes=${transform.finalBytes},width=${transform.width ?? ""},height=${transform.height ?? ""}`,
        },
      });

      // Delete the original-extension sibling. Best-effort: an orphan
      // doesn't break anything user-facing but burns R2 storage.
      try {
        await bucket.delete(originalKey);
      } catch (delErr) {
        await logError(db, {
          level: "warn",
          message: "upload-image-pipeline: Phase 2b cleanup delete failed (non-fatal)",
          error: delErr,
          source: "upload-image-pipeline",
          context: { originalKey, targetType, targetId, uploadSource },
        });
      }

      finalKey = webpKey;
      finalContentType = "image/webp";
      finalBytesCount = transform.finalBytes;
      phase2bWidth = transform.width;
      phase2bHeight = transform.height;
      phase2bDurationMs = transform.durationMs;
    } catch (e) {
      phase2bStatus = "fallback";
      if (e instanceof ImageTransformError) {
        phase2bErrorDetail = `status=${e.status} ${e.detail.slice(0, 200)}`;
      } else {
        phase2bErrorDetail = e instanceof Error ? e.message : String(e);
      }
      await logError(db, {
        level: "warn",
        message: "upload-image-pipeline: Phase 2b transform failed; falling back to original bytes",
        error: e,
        source: "upload-image-pipeline",
        context: { originalKey, targetType, targetId, uploadSource },
      });
    }
  }

  const url = `${CDN_BASE}/${finalKey}`;
  let photoId: string | undefined;

  try {
    if (isGallery) {
      // OPE-211 — APPEND, never overwrite. New photos land at the end of the
      // gallery: one past the current max sort_order for this vendor.
      const [maxRow] = await db
        .select({ max: sql<number | null>`MAX(${vendorPhotos.sortOrder})` })
        .from(vendorPhotos)
        .where(eq(vendorPhotos.vendorId, targetId));
      const now = new Date();
      photoId = crypto.randomUUID();
      await db.insert(vendorPhotos).values({
        id: photoId,
        vendorId: targetId,
        photoUrl: url,
        caption,
        altText: null,
        sortOrder: (maxRow?.max ?? -1) + 1,
        photoType: "other",
        isFeatured: false,
        uploadedBy: actorId,
        createdAt: now,
        updatedAt: now,
      });
    } else if (targetType === "event") {
      await db.update(events).set({ imageUrl: url }).where(eq(events.id, targetId));
      await recomputeEventCompleteness(db, targetId);
    } else if (targetType === "vendor") {
      await db.update(vendors).set({ logoUrl: url }).where(eq(vendors.id, targetId));
    } else if (targetType === "promoter") {
      // OPE-33 — write the role-selected column (logo_url default, hero_image_url
      // when imageRole === "hero", per OPE-34's two promoter image fields).
      await db
        .update(promoters)
        .set(imageColumn === "heroImageUrl" ? { heroImageUrl: url } : { logoUrl: url })
        .where(eq(promoters.id, targetId));
    } else {
      await db.update(venues).set({ imageUrl: url }).where(eq(venues.id, targetId));
    }
  } catch (e) {
    await logError(db, {
      message: "upload-image-pipeline: DB update failed (R2 has the file)",
      error: e,
      source: "upload-image-pipeline",
      context: { key: finalKey, targetType, targetId, uploadSource },
    });
    return {
      ok: false,
      status: 502,
      body: {
        error: "Uploaded but DB update failed; paste URL manually",
        url,
        key: finalKey,
      },
    };
  }

  const compressionRatio =
    phase2bStatus === "applied" && bytes.length > 0
      ? Number((finalBytesCount / bytes.length).toFixed(3))
      : null;

  return {
    ok: true,
    body: {
      url,
      key: finalKey,
      content_type: finalContentType,
      target_type: targetType,
      target_id: targetId,
      image_column: imageColumn,
      ...(photoId ? { photo_id: photoId } : {}),
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
    },
  };
}
