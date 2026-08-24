export const dynamic = "force-dynamic";
/**
 * OPE-409 — GET /api/admin/inbound-attachment/[token]
 *
 * Streams one inbound-email attachment to the bearer of a short-lived download
 * slot. This is the route that makes closing the public
 * `cdn.meetmeatthefair.com/inbound-attachments/` prefix possible without
 * breaking recovery — John's condition on the whole ticket: *"Don't block until
 * you have a way to access. It is only the public that should be blocked, not
 * you."*
 *
 * Why a token route when the session/internal-key route already exists:
 *
 *  - `fetch_inbound_attachment` returns base64 in an MCP result and caps at
 *    1.5 MB. 52 of 88 stored attachments (59%) are over it, including all five
 *    of this ticket's reference-case photos. The cap is not arbitrary — base64
 *    inflates 4/3 and the result is read into a model's context — so the bytes
 *    have to leave the MCP channel, not be squeezed harder through it.
 *  - The internal key cannot be handed to an agent to curl with; it is a Worker
 *    secret and it never expires. A slot grants one attachment for ten minutes.
 *
 * It is deliberately NOT on the CDN hostname: it is served by the app Worker
 * and reads R2 through the `VENDOR_ASSETS` binding, so a WAF rule scoped to
 * `cdn.meetmeatthefair.com/inbound-attachments/*` does not touch it. That is
 * the "public blocked, us not" separation the ticket needs, and it is only
 * achievable this way round — a WAF rule cannot distinguish our own
 * server-side fetches of the public hostname from anyone else's.
 *
 * The token IS the authorization, so: never echo it in an error body, never log
 * it, and answer every failure with a flat 404 so the route cannot be used to
 * probe which emails or indexes exist.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { resolveAttachmentDownloadSlot } from "@/lib/attachment-download-token";
import { resolveAttachmentRef, streamAttachment } from "@/lib/inbound-attachment-stream";

/** One response for every failure — see the note on probing above. */
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    // A missing binding is OUR fault, not a bad token, and it must not read as
    // "that attachment is gone" — that is the misdiagnosis this ticket's own
    // history is full of.
    return NextResponse.json({ error: "slot_storage_unavailable" }, { status: 503 });
  }

  const claims = await resolveAttachmentDownloadSlot(kv, token);
  if (!claims) return notFound();

  const db = getCloudflareDb();
  const resolved = await resolveAttachmentRef(db, claims.inboundEmailId, claims.index);
  if (!resolved.ok) {
    // Flatten every lookup outcome to 404. The holder of a valid slot already
    // knows which attachment it points at, so the distinction tells them
    // nothing and would leak shape to anyone guessing tokens.
    return notFound();
  }

  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };
  return streamAttachment(env.VENDOR_ASSETS, resolved.ref, claims.index, {
    // Always a download: the slot exists for programmatic recovery, and an
    // inline render is the browser use case the session route already serves.
    download: request.nextUrl.searchParams.get("inline") !== "1",
  });
}
