export const dynamic = "force-dynamic";
/**
 * OPE-1580 — public download of one posted vendor form.
 *
 * Goes through here rather than a CDN URL so that withdrawal and expiry take
 * effect on the next request: the status and expiry are read each time, and
 * nothing is cached. The R2 key is never shown to the visitor.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  eventDocumentExtension,
  isEventDocumentLive,
  isEventDocumentMimeType,
} from "@takemetothefair/utils";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { eventDocuments } from "@/lib/db/schema";

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getCloudflareDb();
  const [doc] = await db.select().from(eventDocuments).where(eq(eventDocuments.id, id)).limit(1);
  if (!doc || !isEventDocumentLive(doc) || !isEventDocumentMimeType(doc.mimeType)) {
    return NOT_FOUND();
  }
  const bucket = getCloudflareEnv().VENDOR_ASSETS;
  const object = await bucket?.get(doc.r2Key);
  if (!object) return NOT_FOUND();

  const filename = `${doc.displayName.replace(/[^\w .-]+/g, "_")}.${eventDocumentExtension(doc.mimeType)}`;
  return new NextResponse(object.body, {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(doc.sizeBytes),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
