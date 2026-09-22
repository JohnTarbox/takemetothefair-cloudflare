export const dynamic = "force-dynamic";
/**
 * OPE-1112 — a vendor sets their OWN logo.
 *
 * OPE-211 §5 specified "a logged-in vendor manages their own logo + gallery".
 * The gallery half shipped in increment 3; this is the logo half, three weeks
 * and one customer complaint later.
 *
 * ── What the gap actually cost ────────────────────────────────────────────
 *
 * Until now the only vendor-facing way to set a logo was a text input asking
 * for a URL. A maker who has photos on her phone and a Facebook page — which
 * is most of them — has no hosted image URL to paste, so she pastes the one
 * URL she owns. Measured on prod 2026-09-22: 8 of 114 logo values were page
 * links, and every single one belonged to a CLAIMED vendor. Not one was
 * scraped. The field taught people to do it, and then rendered a blank square.
 *
 * So validation alone would have been the wrong fix: rejecting her Facebook
 * URL without offering an upload leaves her with no way to set a logo at all,
 * which is a worse answer than the blank square. The two ship together.
 *
 * ── Deliberately not a loosened copy of the admin route ───────────────────
 *
 * `/api/admin/vendors/[id]/upload-logo` stays admin-only. This endpoint reuses
 * `runUploadPipeline` and `authorizeVendorGallery` — the same functions the
 * gallery self-service route calls — so the EXIF/GPS strip, the magic-byte
 * sniff, the WebP conversion, the R2 key shape and the ownership rule are the
 * SAME CODE, not the same intention. A second implementation of an
 * authorization rule is how the public-facing copy ends up the permissive one.
 *
 * DELETE clears the column rather than deleting the R2 object: the same image
 * may be referenced by a gallery row or an older revision, and an orphaned
 * object costs fractions of a cent while a broken reference costs a vendor
 * their brand image.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { authorizeVendorGallery } from "@/lib/vendor-photo-auth";
import { runUploadPipeline } from "@/lib/upload-image-pipeline";
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

  const result = await runUploadPipeline({
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    fileName: file.name || "logo",
    targetType: "vendor",
    targetId: vendorId,
    // The point of this route. `resolveImageTarget("vendor", "logo")` writes
    // `vendors.logo_url`; "gallery" would append a photo and leave the logo
    // untouched, which is the mistake in the other direction.
    imageRole: "logo",
    // A logo has no caption — the column belongs to gallery rows, and the
    // logo path writes `vendors.logo_url`, which has nowhere to put one.
    caption: null,
    actorId: session!.user!.id,
    uploadSource: "vendor-self-service",
    db,
    env: getCloudflareEnv(),
  });

  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  return NextResponse.json(result.body);
}

/**
 * Remove the logo — the third verb the acceptance criteria name ("set,
 * replace and remove"). Replace is just POST again.
 */
export async function DELETE(request: Request) {
  const session = await auth();
  const db = getCloudflareDb();

  let vendorId: string | null = null;
  try {
    const parsed = (await request.json()) as { vendorId?: unknown };
    if (typeof parsed.vendorId === "string") vendorId = parsed.vendorId;
  } catch {
    // fall through to the 400 below
  }
  if (!vendorId) {
    return NextResponse.json({ error: "vendorId is required" }, { status: 400 });
  }

  const gate = await authorizeVendorGallery(db, vendorId, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  await db.update(vendors).set({ logoUrl: null }).where(eq(vendors.id, vendorId));

  // OPE-1112 scope 5 / the OPE-830 family — say what was written. A save that
  // reports success without naming the field it touched is how a silent no-op
  // survives review, and that is the exact failure mode this ticket exists to
  // stop repeating.
  return NextResponse.json({ success: true, fieldsChanged: ["logo_url"], logoUrl: null });
}
