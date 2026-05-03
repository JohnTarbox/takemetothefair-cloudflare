/**
 * Server-side R2 upload for vendor logos. Posted as multipart form-data
 * (field name: "file"). Returns the CDN URL on success.
 *
 * Why server-side rather than presigned URL: simpler. Workers can `.put()`
 * directly to R2 via the binding, no signing dance. The 30s Workers budget
 * is more than enough for typical logo sizes (1-2 MB max we accept).
 *
 * Auth: ADMIN session. Vendors don't self-upload via this endpoint —
 * Enhanced Profile is admin-managed in Phase 1 (per project_enhanced_profile
 * memory). When/if vendor self-service ships, this endpoint stays admin-only
 * and a separate vendor-scoped endpoint gets added.
 *
 * Naming convention: `vendors/{vendorId}/logo-{ts}.{ext}` — timestamp suffix
 * defeats CDN caching when the admin replaces a logo.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const runtime = "edge";

interface Params {
  params: Promise<{ id: string }>;
}

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

const CDN_BASE = "https://cdn.meetmeatthefair.com";

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

export async function POST(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Confirm vendor exists before paying for the upload.
  const db = getCloudflareDb();
  const existing = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, id));
  if (existing.length === 0) {
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e) {
    await logError(db, {
      message: "vendor-logo-upload: invalid multipart body",
      error: e,
      source: "admin-vendor-logo-upload",
    });
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 400 }
    );
  }

  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: `Unsupported content type "${contentType}". Allowed: jpg/png/webp/svg.` },
      { status: 400 }
    );
  }

  const ext = extensionFor(contentType);
  if (!ext) {
    // Should be unreachable given the ALLOWED_TYPES check, but keep the
    // narrow-by-mapping invariant explicit.
    return NextResponse.json({ error: "Unsupported content type" }, { status: 400 });
  }

  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };
  const bucket = env.VENDOR_ASSETS;
  if (!bucket) {
    return NextResponse.json(
      { error: "R2 bucket not bound (VENDOR_ASSETS missing)" },
      { status: 500 }
    );
  }

  const key = `vendors/${id}/logo-${Date.now()}.${ext}`;

  try {
    const body = await file.arrayBuffer();
    await bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { uploadedBy: session.user.id, originalName: file.name },
    });
  } catch (e) {
    await logError(db, {
      message: "vendor-logo-upload: R2 put failed",
      error: e,
      source: "admin-vendor-logo-upload",
      context: { key },
    });
    return NextResponse.json({ error: "Upload failed" }, { status: 502 });
  }

  const url = `${CDN_BASE}/${key}`;

  // Set the vendor's logo_url to the new URL. Doing it server-side here
  // (rather than expecting the client to PATCH separately) keeps the upload
  // atomic from the admin's perspective: one click → R2 + DB consistent.
  try {
    await db.update(vendors).set({ logoUrl: url }).where(eq(vendors.id, id));
  } catch (e) {
    await logError(db, {
      message: "vendor-logo-upload: DB update failed (R2 has the file)",
      error: e,
      source: "admin-vendor-logo-upload",
      context: { key, vendorId: id },
    });
    // R2 already has the file; the DB update failed. Surface the error so the
    // admin can retry — but the URL is still useful (manual paste into edit
    // form would work).
    return NextResponse.json(
      { error: "Uploaded but DB update failed; paste URL manually", url },
      { status: 502 }
    );
  }

  return NextResponse.json({ url, key });
}
