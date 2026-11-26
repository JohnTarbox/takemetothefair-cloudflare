export const dynamic = "force-dynamic";
/**
 * OPE-1618 — the operator path: an admin (session) or the MCP Worker
 * (INTERNAL_API_KEY, `import_promoter_spreadsheet`) runs the SAME import for a
 * promoter who emailed us a spreadsheet. Same preview / commit, same ledger,
 * recorded with channel `operator`. The promoter need not be claimed — the
 * operator is vouching — but every new event still goes in PENDING (review).
 *
 * POST JSON: { file_base64, file_name?, action: "preview"|"commit", offset?, rows?, actorUserId? }
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withAuthorized } from "@/lib/api/with-auth";
import { promoters } from "@/lib/db/schema";
import { handleImport } from "@/lib/promoter-import/handle";

export const POST = withAuthorized<{ id: string }>(async ({ request, db, userId, params }) => {
  const { id } = params;
  const [promoter] = await db
    .select({ id: promoters.id })
    .from(promoters)
    .where(eq(promoters.id, id))
    .limit(1);
  if (!promoter) return NextResponse.json({ error: "promoter not found" }, { status: 404 });
  let body: {
    file_base64?: string;
    file_name?: string;
    action?: string;
    offset?: number;
    rows?: number[];
    actorUserId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  if (!body.file_base64)
    return NextResponse.json({ error: "file_base64 is required" }, { status: 400 });
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(body.file_base64), (c) => c.charCodeAt(0));
  } catch {
    return NextResponse.json({ error: "file_base64 is not base64" }, { status: 400 });
  }
  return handleImport(
    db,
    {
      bytes,
      fileName: body.file_name ?? null,
      action: body.action === "commit" ? "commit" : "preview",
      offset: Number(body.offset ?? 0) || 0,
      commitRows: Array.isArray(body.rows) ? body.rows.map(Number).filter(Number.isInteger) : [],
    },
    { promoterId: promoter.id, uploadedBy: userId ?? body.actorUserId ?? null, channel: "operator" }
  );
});
