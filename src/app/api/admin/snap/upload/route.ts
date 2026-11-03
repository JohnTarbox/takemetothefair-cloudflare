export const dynamic = "force-dynamic";
/**
 * POST /api/admin/snap/upload — OPE-1341. One photo from the phone capture page.
 *
 * ADMIN-only. A thin authenticated proxy: the MCP Worker owns the photo-intake
 * lane (Workflow, vision, R2 strip-then-store), so this forwards the multipart
 * body to `/api/admin/internal/snap-intake` with the internal key and the
 * session's email as the actor. Idempotent upstream on `meta.clientId`, so the
 * phone's offline queue may retry freely — a repeat returns the same row id.
 *
 * Multipart: `file` (image), `meta` (JSON: clientId, capturedAt, latitude,
 * longitude, accuracyM, takenOnLocalDate, eventId, eventSlug, note).
 */
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";

const MCP_URL = "https://mcp.meetmeatthefair.com";
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = withAuth({ role: "ADMIN" }, async ({ request, session }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  const meta = form.get("meta");
  if (!(file instanceof File) || typeof meta !== "string") {
    return NextResponse.json({ error: "file and meta are required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file exceeds 10 MB" }, { status: 413 });
  }
  const actor = session.user.email;
  if (!actor) {
    return NextResponse.json({ error: "session has no email" }, { status: 403 });
  }

  const cfEnv = getCloudflareEnv();
  if (!cfEnv.INTERNAL_API_KEY) {
    return NextResponse.json(
      { error: "internal_misconfigured", message: "INTERNAL_API_KEY missing" },
      { status: 503 }
    );
  }

  const upstreamForm = new FormData();
  upstreamForm.set("file", file, file.name || "snap.jpg");
  upstreamForm.set("meta", meta);
  upstreamForm.set("actor", actor);
  const upstream = await fetch(`${MCP_URL}/api/admin/internal/snap-intake`, {
    method: "POST",
    headers: { "x-internal-key": cfEnv.INTERNAL_API_KEY },
    body: upstreamForm,
  });
  const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(
    upstream.ok ? body : { error: body.error ?? `MCP returned ${upstream.status}` },
    {
      status: upstream.status,
    }
  );
});
