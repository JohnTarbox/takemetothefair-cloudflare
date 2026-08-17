export const dynamic = "force-dynamic";
/**
 * OPE-187 — GET /api/admin/inbound-emails/[id]/attachments/[index]
 *
 * Streams one inbound-email attachment (emailed poster/flyer/PDF) from R2 so the
 * admin can actually view or download it — the detail panel previously showed only
 * a bare "Attachments: N" count. The bytes live in the VENDOR_ASSETS bucket under
 * the `inbound-attachments/` prefix (written by the MCP email-receive Worker); the
 * main app already binds VENDOR_ASSETS, so we read them directly.
 *
 * Admin-gated: inbound attachments can contain PII, so this MUST require an admin
 * session OR the internal service key (OPE-409 — agents recover attachments, and
 * a human-only download cannot be the recovery path), and MUST NOT be exposed
 * publicly or via cdn.meetmeatthefair.com. Serves
 * the stored mimeType, inline by default (so <img> previews render) and as a
 * download when `?dl=1`. Defense-in-depth: only keys under `inbound-attachments/`
 * are ever served, so a tampered/legacy ref can't read arbitrary R2 objects.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { inboundEmails } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

interface AttachmentRef {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> }
) {
  // OPE-409 step 2 — this route is the ONLY authenticated way to read an
  // inbound attachment, and until now it accepted a browser session only. That
  // makes it a human-only download button, which is explicitly not enough:
  // attachment recovery is done by AGENTS. The 2026-08-15 rescue pulled five
  // photos and re-uploaded them via `request_image_upload_slot`, and that
  // workflow has to survive whatever locks down the public CDN path.
  //
  // So the same `X-Internal-Key` the MCP Worker already presents to the other
  // admin write routes is accepted here. Without it, closing the public
  // `inbound-attachments/` prefix would trade a low-severity exposure for a real
  // operational loss — the ability to rescue photos the pipeline drops.
  //
  // Session OR internal key; both are admin-equivalent, and the internal key is
  // only known to our own Workers.
  const internalKey = request.headers.get("x-internal-key");
  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  const isInternal = !!(
    internalKey &&
    cfEnv.INTERNAL_API_KEY &&
    internalKey === cfEnv.INTERNAL_API_KEY
  );
  if (!isInternal) {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { id, index } = await params;
  const idx = Number.parseInt(index, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return NextResponse.json({ error: "bad_index" }, { status: 400 });
  }

  const db = getCloudflareDb();
  const [row] = await db
    .select({ attachmentRefs: inboundEmails.attachmentRefs })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .limit(1);
  if (!row || !row.attachmentRefs) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let refs: AttachmentRef[];
  try {
    refs = JSON.parse(row.attachmentRefs) as AttachmentRef[];
  } catch {
    return NextResponse.json({ error: "bad_refs" }, { status: 500 });
  }
  const ref = Array.isArray(refs) ? refs[idx] : undefined;
  if (!ref || typeof ref.key !== "string") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Only ever serve keys under the inbound-attachments prefix.
  if (!ref.key.startsWith("inbound-attachments/")) {
    return NextResponse.json({ error: "forbidden_key" }, { status: 403 });
  }

  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };
  const bucket = env.VENDOR_ASSETS;
  if (!bucket) {
    return NextResponse.json({ error: "storage_unavailable" }, { status: 503 });
  }
  const obj = await bucket.get(ref.key);
  if (!obj) {
    return NextResponse.json({ error: "object_missing" }, { status: 404 });
  }

  const download = request.nextUrl.searchParams.get("dl") === "1";
  const mime = ref.mimeType || obj.httpMetadata?.contentType || "application/octet-stream";
  // Strip characters that could break the Content-Disposition header.
  const safeName = (ref.name || `attachment-${idx}`).replace(/[\r\n"\\]/g, "_");

  // XSS defense: mimeType is attacker-influenced (it comes off the inbound email).
  // Only render KNOWN-SAFE raster/pdf types inline — crucially NOT image/svg+xml
  // (an image/* type that executes script) or text/html. Everything else is forced
  // to a download. CSP sandbox + CORP are belt-and-suspenders so anything that does
  // render can't touch the admin origin.
  const SAFE_INLINE = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "application/pdf",
  ]);
  const inline = !download && SAFE_INLINE.has(mime.toLowerCase());

  return new NextResponse(obj.body, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      // Private admin content — never cache in shared/edge caches.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
