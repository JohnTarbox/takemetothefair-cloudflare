export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { promoters, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createSlug } from "@/lib/utils";
import { getPromotersWithCounts } from "@/lib/queries";
import { promoterCreateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { indexNowUrlFor } from "@/lib/indexnow";
import { enqueueIndexNow } from "@/lib/queues/producers";
import { computePromoterEnrichment } from "@takemetothefair/constants";
import { findPromoterDuplicates } from "@takemetothefair/utils";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  try {
    const promotersWithCounts = await getPromotersWithCounts(db);
    return NextResponse.json(promotersWithCounts);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch promoters",
      error,
      source: "api/admin/promoters",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch promoters" }, { status: 500 });
  }
});

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  // Validate request body
  const validation = await validateRequestBody(request, promoterCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const promoterId = crypto.randomUUID();

    // OPE-858 — warn-only duplicate advisory.
    //
    // This route had NO duplicate detection of any kind — not even the exact
    // company-name check the MCP `create_promoter` tool carries. Two intake
    // paths, two different answers to "is this already here?", and the split
    // that produced `New England Premier Events` / `My New England Event` (one
    // company, myneevent.com, two rows one day apart) came from exactly that:
    // two ingestion paths, one company, nothing comparing them.
    //
    // Advisory ONLY. Nothing here can refuse the create — a naive rule returns
    // more false positives than true ones across the 748-row table, so the
    // matcher deliberately exposes no score and no threshold.
    const dupCandidates = await db
      .select({
        id: promoters.id,
        slug: promoters.slug,
        companyName: promoters.companyName,
        website: promoters.website,
        state: promoters.state,
      })
      .from(promoters);
    const possibleDuplicates = findPromoterDuplicates(
      {
        name: data.companyName,
        website: data.website ?? null,
        // This route's schema has no `state` field, so axis 2 cannot fire here
        // today. Passing null rather than omitting it keeps that fact visible:
        // the axis is wired and starved, not absent. It starts working the day
        // the create form gains a state.
        state: null,
      },
      dupCandidates
    );

    // OPE-35 — seed enrichment rails from the create fields (this API doesn't
    // accept hero/contact, so those start uncovered).
    const enrichment = computePromoterEnrichment({
      website: data.website ?? null,
      logoUrl: data.logoUrl ?? null,
      socialLinks: data.socialLinks ?? null,
      description: data.description ?? null,
    });

    await db.insert(promoters).values({
      id: promoterId,
      userId: data.userId || null,
      companyName: data.companyName,
      slug: createSlug(data.companyName),
      description: data.description,
      website: data.website,
      socialLinks: data.socialLinks,
      logoUrl: data.logoUrl,
      verified: data.verified,
      enrichmentStatus: enrichment.status,
      enrichmentCoverage: enrichment.coverageJson,
    });

    // Update user role to PROMOTER only if a user is linked
    if (data.userId) {
      await db.update(users).set({ role: "PROMOTER" }).where(eq(users.id, data.userId));
    }

    const [newPromoter] = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, promoterId))
      .limit(1);

    // IndexNow: enqueue the canonical promoter URL for async ping. The
    // queue consumer (MCP worker) batches across messages and submits
    // to Bing in one API call. Falls back to direct ping when the
    // INDEXNOW_PINGS binding is unbound (local dev).
    if (newPromoter?.slug) {
      await enqueueIndexNow(indexNowUrlFor("promoters", newPromoter.slug), "promoter.create");
    }

    // OPE-858 — 201 regardless. The advisory rides alongside the created row.
    return NextResponse.json(
      possibleDuplicates.length > 0
        ? { ...newPromoter, possible_duplicates: possibleDuplicates }
        : newPromoter,
      { status: 201 }
    );
  } catch (error) {
    await logError(db, {
      message: "Failed to create promoter",
      error,
      source: "api/admin/promoters",
      request,
    });
    return NextResponse.json({ error: "Failed to create promoter" }, { status: 500 });
  }
});
