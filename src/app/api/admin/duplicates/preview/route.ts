import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getMergePreview } from "@/lib/duplicates/merge-operations";
import type { DuplicateEntityType, MergePreviewRequest } from "@/lib/duplicates/types";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body: MergePreviewRequest = await request.json();
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

    const db = getCloudflareDb();
    const preview = await getMergePreview(
      db,
      type as DuplicateEntityType,
      primaryId,
      duplicateId
    );

    return NextResponse.json(preview);
  } catch (error) {
    console.error("Failed to generate merge preview:", error);
    const message = error instanceof Error ? error.message : "Failed to generate merge preview";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
