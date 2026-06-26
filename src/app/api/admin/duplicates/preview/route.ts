export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getMergePreview } from "@/lib/duplicates/merge-operations";
import type { DuplicateEntityType, MergePreviewRequest } from "@/lib/duplicates/types";
import { logError } from "@/lib/logger";

// K8 (analyst, 2026-06-01). Dual auth (admin session OR X-Internal-Key, via
// withAuthorized — constant-time, replacing K3's timing-unsafe `===`) so the
// MCP-server merge_events tool can preview before committing. Read-only — no
// actorUserId needed; both branches converge on the same SELECT.
export const POST = withAuthorized(async ({ request, db }) => {
  let body: MergePreviewRequest | null = null;

  try {
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
});
