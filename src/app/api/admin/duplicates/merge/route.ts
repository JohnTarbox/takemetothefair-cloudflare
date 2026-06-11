export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { executeMerge } from "@/lib/duplicates/merge-operations";
import type { DuplicateEntityType, MergeRequest } from "@/lib/duplicates/types";
import { logError } from "@/lib/logger";

export async function POST(request: NextRequest) {
  let db: ReturnType<typeof getCloudflareDb> | null = null;
  let body: (MergeRequest & { actorUserId?: string | null }) | null = null;

  try {
    // K3 (analyst, 2026-05-31): accept INTERNAL_API_KEY in addition to
    // admin session so the MCP-server `merge_events` tool can call this
    // endpoint without a Next.js session cookie. Same pattern as
    // /api/suggest-event/check-duplicate. When authenticated via the
    // internal key the caller supplies actorUserId in the body (the
    // MCP server has its own AuthContext.userId on the calling user);
    // session callers ignore the body field and use session.user.id.
    const internalKey = request.headers.get("x-internal-key");
    const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
    const isInternal = !!(
      internalKey &&
      cfEnv.INTERNAL_API_KEY &&
      internalKey === cfEnv.INTERNAL_API_KEY
    );

    let sessionActorUserId: string | null = null;
    if (!isInternal) {
      const session = await auth();
      if (!session || session.user.role !== "ADMIN") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      sessionActorUserId = session.user.id;
    }

    db = getCloudflareDb();
    body = (await request.json()) as MergeRequest & { actorUserId?: string | null };
    const { type, primaryId, duplicateId } = body;
    const actorUserId = isInternal ? (body.actorUserId ?? null) : sessionActorUserId;

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

    const result = await executeMerge(
      db,
      type as DuplicateEntityType,
      primaryId,
      duplicateId,
      actorUserId
    );

    return NextResponse.json(result);
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.message.includes("time") ||
        error.message.includes("CPU") ||
        error.message.includes("exceeded"));

    await logError(db, {
      message: "Failed to execute merge",
      error,
      source: "api/admin/duplicates/merge",
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
      ? "The merge operation timed out. This can happen with records that have many relationships. Please try again."
      : error instanceof Error
        ? error.message
        : "Failed to execute merge";

    return NextResponse.json({ error: userMessage, isTimeout }, { status: isTimeout ? 503 : 500 });
  }
}
