export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { executeMerge } from "@/lib/duplicates/merge-operations";
import type { DuplicateEntityType, MergeRequest } from "@/lib/duplicates/types";
import { logError } from "@/lib/logger";
import { events } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { differentEditionYears } from "@/lib/series/merge-year-guard";

export const POST = withAuthorized(async ({ request, db, userId }) => {
  let body: (MergeRequest & { actorUserId?: string | null }) | null = null;

  try {
    // K3 (analyst, 2026-05-31): accepts an admin session OR INTERNAL_API_KEY
    // so the MCP-server `merge_events` tool can call this without a Next.js
    // session cookie — now gated via withAuthorized (constant-time). The actor
    // id is the admin's session user id (withAuthorized's `userId`), or — for
    // an internal-key caller (userId is null then) — the `actorUserId` the MCP
    // server supplies in the body. Session callers ignore the body field.
    body = (await request.json()) as MergeRequest & { actorUserId?: string | null };
    const { type, primaryId, duplicateId } = body;
    const actorUserId = userId ?? body.actorUserId ?? null;

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

    // EH3 P3.2 — cross-year merge guard. Two events whose start-years differ are
    // different EDITIONS of a series, not duplicates; merging would fuse their
    // per-year vendor rosters (the original 548-link Newport/Norwalk incident
    // class). Hard-refuse and point the operator at create_occurrence. Same-year
    // / unknown-year pairs fall through to the normal merge.
    if (type === "events") {
      const rows = await db
        .select({ id: events.id, startDate: events.startDate })
        .from(events)
        .where(inArray(events.id, [primaryId, duplicateId]));
      const keeper = rows.find((r) => r.id === primaryId);
      const dup = rows.find((r) => r.id === duplicateId);
      if (keeper && dup && differentEditionYears(keeper.startDate, dup.startDate)) {
        return NextResponse.json(
          {
            error: "different_editions",
            keeper_year: keeper.startDate?.getUTCFullYear() ?? null,
            duplicate_year: dup.startDate?.getUTCFullYear() ?? null,
            message:
              "These are different editions (different years), not duplicates. Link them as " +
              "occurrences of one series with create_occurrence — merging would fuse their " +
              "per-year vendor rosters across years.",
          },
          { status: 409 }
        );
      }
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
});
