export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getMergePreview } from "@/lib/duplicates/merge-operations";
import type { DuplicateEntityType, MergePreviewRequest } from "@/lib/duplicates/types";
import { logError } from "@/lib/logger";

export async function POST(request: NextRequest) {
  let db: ReturnType<typeof getCloudflareDb> | null = null;
  let body: MergePreviewRequest | null = null;

  try {
    // K8 (analyst, 2026-06-01). Accept INTERNAL_API_KEY in addition to
    // admin session so the MCP-server merge_events tool can preview
    // before committing. Mirrors the same auth dual-path on the sibling
    // merge route (src/app/api/admin/duplicates/merge/route.ts:22-37)
    // added in K3. The preview path is read-only, so no actorUserId is
    // needed in the body — both branches converge on the same SELECT.
    // WS3b — constant-time X-Internal-Key check via the shared helper (was a
    // timing-unsafe `===`).
    const isInternal = await internalKeyMatches(request);

    if (!isInternal) {
      const session = await auth();
      if (!session || session.user.role !== "ADMIN") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    db = getCloudflareDb();
    body = (await request.json()) as MergePreviewRequest;
    const { type, primaryId, duplicateId } = body;

    if (!type || !["venues", "events", "vendors", "promoters"].includes(type)) {
      return NextResponse.json({ error: "Invalid or missing type parameter" }, { status: 400 });
    }

    if (!primaryId || !duplicateId) {
      return NextResponse.json(
        { error: "Both primaryId and duplicateId are required" },
        { status: 400 }
      );
    }

    if (primaryId === duplicateId) {
      return NextResponse.json({ error: "Cannot merge an entity with itself" }, { status: 400 });
    }

    const preview = await getMergePreview(db, type as DuplicateEntityType, primaryId, duplicateId);

    return NextResponse.json(preview);
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.message.includes("time") ||
        error.message.includes("CPU") ||
        error.message.includes("exceeded"));

    await logError(db, {
      message: "Failed to generate merge preview",
      error,
      source: "api/admin/duplicates/preview",
      request,
      context: {
        entityType: body?.type,
        primaryId: body?.primaryId,
        duplicateId: body?.duplicateId,
        isTimeout,
      },
      statusCode: isTimeout ? 503 : 500,
    });

    const userMessage = isTimeout
      ? "The preview timed out. Please try again."
      : error instanceof Error
        ? error.message
        : "Failed to generate merge preview";

    return NextResponse.json({ error: userMessage, isTimeout }, { status: isTimeout ? 503 : 500 });
  }
}
