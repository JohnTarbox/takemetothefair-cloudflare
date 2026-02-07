import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { executeMerge } from "@/lib/duplicates/merge-operations";
import type { DuplicateEntityType, MergeRequest } from "@/lib/duplicates/types";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  let db: ReturnType<typeof getCloudflareDb> | null = null;
  let body: MergeRequest | null = null;

  try {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    db = getCloudflareDb();
    body = await request.json() as MergeRequest;
    const { type, primaryId, duplicateId } = body;

    if (!type || !["venues", "events", "vendors", "promoters"].includes(type)) {
      return NextResponse.json(
        { error: "Invalid or missing type parameter" },
        { status: 400 }
      );
    }

    if (!primaryId || !duplicateId) {
      return NextResponse.json(
        { error: "Both primaryId and duplicateId are required" },
        { status: 400 }
      );
    }

    if (primaryId === duplicateId) {
      return NextResponse.json(
        { error: "Cannot merge an entity with itself" },
        { status: 400 }
      );
    }

    const result = await executeMerge(
      db,
      type as DuplicateEntityType,
      primaryId,
      duplicateId
    );

    return NextResponse.json(result);
  } catch (error) {
    const isTimeout = error instanceof Error &&
      (error.message.includes("time") || error.message.includes("CPU") || error.message.includes("exceeded"));

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
      : error instanceof Error ? error.message : "Failed to execute merge";

    return NextResponse.json(
      { error: userMessage, isTimeout },
      { status: isTimeout ? 503 : 500 }
    );
  }
}
