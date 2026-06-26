export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { promoters, events, users } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { promoterUpdateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ request, db, params }) => {
  const { id } = params;

  try {
    const promoterResults = await db
      .select()
      .from(promoters)
      .leftJoin(users, eq(promoters.userId, users.id))
      .where(eq(promoters.id, id))
      .limit(1);

    if (promoterResults.length === 0) {
      return NextResponse.json({ error: "Promoter not found" }, { status: 404 });
    }

    const promoter = promoterResults[0];

    const promoterEvents = await db
      .select()
      .from(events)
      .where(eq(events.promoterId, id))
      .orderBy(desc(events.startDate))
      .limit(10);

    return NextResponse.json({
      ...promoter.promoters,
      user: promoter.users ? { email: promoter.users.email, name: promoter.users.name } : null,
      events: promoterEvents,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch promoter",
      error,
      source: "api/admin/promoters/[id]",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch promoter" }, { status: 500 });
  }
});

export const PATCH = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params }) => {
    const { id } = params;

    // Validate request body
    const validation = await validateRequestBody(request, promoterUpdateSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const data = validation.data;

    try {
      // Read prior slug so we can ping IndexNow for both old + new on rename.
      const [prior] = await db
        .select({ slug: promoters.slug })
        .from(promoters)
        .where(eq(promoters.id, id))
        .limit(1);

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (data.companyName) {
        updateData.companyName = data.companyName;
        updateData.slug = createSlug(data.companyName);
      }
      if (data.description !== undefined) updateData.description = data.description;
      if (data.website !== undefined) updateData.website = data.website;
      if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
      // IMG1 §1b Phase 1 (2026-06-08) — focal point clamped.
      if (typeof data.imageFocalX === "number" && Number.isFinite(data.imageFocalX)) {
        updateData.imageFocalX = Math.max(0, Math.min(1, data.imageFocalX));
      }
      if (typeof data.imageFocalY === "number" && Number.isFinite(data.imageFocalY)) {
        updateData.imageFocalY = Math.max(0, Math.min(1, data.imageFocalY));
      }
      if (data.verified !== undefined) updateData.verified = data.verified;

      await db.update(promoters).set(updateData).where(eq(promoters.id, id));

      const [updatedPromoter] = await db
        .select()
        .from(promoters)
        .where(eq(promoters.id, id))
        .limit(1);

      // IndexNow: ping on every update (content changed). Include the prior
      // slug too if it differs, so search engines can crawl-and-redirect.
      if (updatedPromoter?.slug) {
        const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
        const urls = [indexNowUrlFor("promoters", updatedPromoter.slug)];
        if (prior?.slug && prior.slug !== updatedPromoter.slug) {
          urls.push(indexNowUrlFor("promoters", prior.slug));
        }
        await pingIndexNow(db, urls, env, "promoter.update");
      }

      return NextResponse.json(updatedPromoter);
    } catch (error) {
      await logError(db, {
        message: "Failed to update promoter",
        error,
        source: "api/admin/promoters/[id]",
        request,
      });
      return NextResponse.json({ error: "Failed to update promoter" }, { status: 500 });
    }
  }
);

export const DELETE = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params }) => {
    const { id } = params;

    try {
      // Get promoter to find user
      const promoter = await db.select().from(promoters).where(eq(promoters.id, id)).limit(1);

      if (promoter.length > 0) {
        // Reset user role to USER
        await db.update(users).set({ role: "USER" }).where(eq(users.id, promoter[0].userId!));
      }

      await db.delete(promoters).where(eq(promoters.id, id));
      return NextResponse.json({ success: true });
    } catch (error) {
      await logError(db, {
        message: "Failed to delete promoter",
        error,
        source: "api/admin/promoters/[id]",
        request,
      });
      return NextResponse.json({ error: "Failed to delete promoter" }, { status: 500 });
    }
  }
);
