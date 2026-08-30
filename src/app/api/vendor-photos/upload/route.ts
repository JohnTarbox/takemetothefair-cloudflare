export const dynamic = "force-dynamic";
/**
 * OPE-211 increment 3 — a vendor uploads a gallery photo to their OWN row.
 *
 * The admin route `/api/admin/vendors/[id]/upload-logo` says in its own header:
 * "When/if vendor self-service ships, this endpoint stays admin-only and a
 * separate vendor-scoped endpoint gets added." This is that endpoint.
 *
 * Deliberately NOT a loosened copy of the admin one. It reuses
 * `runUploadPipeline`, the same function every other upload path calls, so the
 * EXIF/GPS strip, the magic-byte sniff, the WebP conversion and the R2 key
 * shape are the SAME CODE rather than the same intent. John's greenlight makes
 * the strip non-negotiable — "EXIF/GPS strip stays mandatory on every write
 * path" — and the way to keep a guarantee like that is to not have a second
 * implementation of it.
 *
 * Every guardrail from that greenlight, and where it lives:
 *   session required            authorizeVendorGallery (401 for anonymous)
 *   own row only                authorizeVendorGallery (404 for someone else's)
 *   rate limited                RATE_LIMITS["vendor-photo-upload"], 20/day
 *   gallery size cap            MAX_GALLERY_PHOTOS below, checked pre-upload
 *   sane validation errors      explicit 400s, never a silent no-op
 *   EXIF/GPS strip              runUploadPipeline, unchanged
 */
import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendorPhotos } from "@/lib/db/schema";
import { authorizeVendorGallery, MAX_GALLERY_PHOTOS } from "@/lib/vendor-photo-auth";
import { runUploadPipeline, type PipelineEnv } from "@/lib/upload-image-pipeline";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  const session = await auth();
  const db = getCloudflareDb();

  const limit = await checkRateLimit(request, "vendor-photo-upload");
  if (!limit.allowed) return rateLimitResponse(limit);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form-data" }, { status: 400 });
  }

  const vendorId = form.get("vendorId");
  const file = form.get("file");
  if (typeof vendorId !== "string" || !vendorId) {
    return NextResponse.json({ error: "vendorId is required" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A file is required" }, { status: 400 });
  }

  const gate = await authorizeVendorGallery(db, vendorId, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.` },
      { status: 400 }
    );
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type "${file.type || "unknown"}". Use JPEG, PNG or WebP.` },
      { status: 400 }
    );
  }

  // Checked BEFORE the upload runs, so an over-cap request costs no R2 write
  // and the vendor gets a real reason rather than a successful-looking upload
  // that vanishes.
  const [{ n }] = await db
    .select({ n: count() })
    .from(vendorPhotos)
    .where(eq(vendorPhotos.vendorId, vendorId));
  if (n >= MAX_GALLERY_PHOTOS) {
    return NextResponse.json(
      {
        error: `Your gallery is full (${MAX_GALLERY_PHOTOS} photos). Delete one to add another.`,
      },
      { status: 400 }
    );
  }

  const caption = form.get("caption");
  const result = await runUploadPipeline({
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    fileName: file.name || "photo",
    targetType: "vendor",
    targetId: vendorId,
    // The whole point. "logo" here would REPLACE the vendor's brand logo —
    // the silent overwrite increment 1's resolveImageTarget was extracted to
    // make impossible.
    imageRole: "gallery",
    caption: typeof caption === "string" && caption ? caption : null,
    actorId: session!.user!.id,
    uploadSource: "vendor-self-service",
    db,
    env: getCloudflareEnv() as unknown as PipelineEnv,
  });

  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  return NextResponse.json(result.body);
}
