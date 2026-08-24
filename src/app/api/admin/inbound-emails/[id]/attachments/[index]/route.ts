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
import { resolveAttachmentRef, streamAttachment } from "@/lib/inbound-attachment-stream";

// The AttachmentRef shape now lives with the shared reader in
// src/lib/inbound-attachment-stream.ts — one definition, two routes.

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

  // OPE-409 — lookup + streaming now live in one shared module, because a
  // second (token-gated) entry point was added and the two must not drift.
  // See src/lib/inbound-attachment-stream.ts.
  const db = getCloudflareDb();
  const resolved = await resolveAttachmentRef(db, id, idx);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.err.error }, { status: resolved.err.status });
  }

  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };
  return streamAttachment(env.VENDOR_ASSETS, resolved.ref, idx, {
    download: request.nextUrl.searchParams.get("dl") === "1",
  });
}
