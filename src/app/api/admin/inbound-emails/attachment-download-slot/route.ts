export const dynamic = "force-dynamic";
/**
 * OPE-409 — POST /api/admin/inbound-emails/attachment-download-slot
 *
 * Mints a short-lived download slot for ONE inbound-email attachment and
 * returns the URL an agent can fetch it from. The MCP Worker calls this with
 * `X-Internal-Key` when `fetch_inbound_attachment` finds an object too large to
 * inline; an admin session works too.
 *
 * Mirrors `/api/admin/upload-image-slot` (K17), pointed the other way: that one
 * moved upload bytes off the MCP channel because a model cannot emit 500 KB of
 * base64 in a tool argument. This moves download bytes off it for the same
 * reason — a 5 MB object is ~6.7 MB of base64 and no context holds it.
 *
 * The slot is validated at issue time rather than only at fetch time, so a bad
 * id or index is a 404 here — where the caller can act on it — instead of a
 * mysterious 404 ten minutes later on a URL it has already handed onward.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { issueAttachmentDownloadSlot } from "@/lib/attachment-download-token";
import { resolveAttachmentRef } from "@/lib/inbound-attachment-stream";
import { SITE_URL } from "@takemetothefair/constants";

interface Body {
  inbound_email_id?: string;
  index?: number;
}

export async function POST(request: NextRequest) {
  let actorId: string;
  if (await internalKeyMatches(request)) {
    actorId = "mcp-worker";
  } else {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    actorId = session.user.id ?? "admin";
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const inboundEmailId = typeof body.inbound_email_id === "string" ? body.inbound_email_id : "";
  const index = typeof body.index === "number" ? body.index : 0;
  if (!inboundEmailId) {
    return NextResponse.json({ error: "inbound_email_id_required" }, { status: 400 });
  }

  // Validate NOW so the caller learns about a bad ref immediately.
  const db = getCloudflareDb();
  const resolved = await resolveAttachmentRef(db, inboundEmailId, index);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.err.error }, { status: resolved.err.status });
  }

  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    return NextResponse.json({ error: "slot_storage_unavailable" }, { status: 503 });
  }

  const slot = await issueAttachmentDownloadSlot(kv, {
    inboundEmailId,
    index,
    issuedBy: actorId,
  });

  return NextResponse.json({
    success: true,
    download_url: `${SITE_URL}/api/admin/inbound-attachment/${slot.token}`,
    expires_at: slot.expiresAt.toISOString(),
    ttl_seconds: slot.ttlSeconds,
    size: resolved.ref.size,
    content_type: resolved.ref.mimeType,
    filename: resolved.ref.name,
  });
}
