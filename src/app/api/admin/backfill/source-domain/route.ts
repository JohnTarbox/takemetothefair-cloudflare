export const dynamic = "force-dynamic";
/**
 * One-time backfill that populates events.source_domain + events.ingestion_method
 * from the existing sourceName / sourceUrl pair. Idempotent: re-running
 * is safe; the WHERE clause filters out rows already populated.
 *
 * Analyst backlog Item 1 (2026-05-26). drizzle/0090 added the columns
 * without populating them; the parser lives in TypeScript
 * (src/lib/source-classification.ts) so the classifier can evolve without
 * re-running raw-SQL migrations.
 *
 * Default `apply=false` (dry-run): returns the proposed assignments
 * without writing. Pass `apply=true` to commit. Optional `limit` caps
 * rows processed per call (defaults to 500). Run multiple times to chew
 * through the backlog.
 *
 * Auth: admin session OR X-Internal-Key.
 */
import { NextResponse } from "next/server";
import { eq, isNull, sql } from "drizzle-orm";
import { withAuthorized } from "@/lib/api/with-auth";
import { events } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { classifySource, type IngestionMethod } from "@/lib/source-classification";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

interface Outcome {
  id: string;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  ingestionMethod: IngestionMethod | null;
  changed: boolean;
}

export const POST = withAuthorized(async ({ request, db }) => {
  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "true";
  const limitParam = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    // Unclassified rows are the ones with null ingestion_method. source_domain
    // may legitimately be null on classified rows too (admin_manual events
    // with no URL), so keying the WHERE on ingestion_method alone is the
    // accurate "needs backfill" signal. The classifier always returns a
    // non-null method (defaults to admin_manual), so every UPDATE here
    // clears the candidate condition — no re-selection loops.
    const candidates = await db
      .select({
        id: events.id,
        sourceName: events.sourceName,
        sourceUrl: events.sourceUrl,
      })
      .from(events)
      .where(isNull(events.ingestionMethod))
      .limit(limit);

    const outcomes: Outcome[] = [];
    let written = 0;
    for (const row of candidates) {
      const classification = classifySource(row.sourceName, row.sourceUrl);
      outcomes.push({
        id: row.id,
        sourceName: row.sourceName,
        sourceUrl: row.sourceUrl,
        sourceDomain: classification.sourceDomain,
        ingestionMethod: classification.ingestionMethod,
        changed: true,
      });
      if (apply) {
        await db
          .update(events)
          .set({
            sourceDomain: classification.sourceDomain,
            ingestionMethod: classification.ingestionMethod,
            // Bump updatedAt so the sitemap MAX(updated_at) picks up the
            // metadata change — keeps the index in sync.
            updatedAt: new Date(),
          })
          .where(eq(events.id, row.id));
        written += 1;
      }
    }

    // Tally by method for quick verification in the response.
    const methodCounts: Record<string, number> = {};
    for (const o of outcomes) {
      const k = o.ingestionMethod ?? "<null>";
      methodCounts[k] = (methodCounts[k] ?? 0) + 1;
    }

    return NextResponse.json({
      success: true,
      apply,
      candidates: candidates.length,
      written,
      methodCounts,
      sample: outcomes.slice(0, 20),
    });
  } catch (e) {
    await logError(db, {
      source: "admin:backfill:source-domain",
      level: "error",
      message: "Backfill failed",
      error: e,
    });
    return NextResponse.json({ error: "Backfill failed" }, { status: 500 });
  }
});

// Counts remaining work. Cheap; no writes.
export const GET = withAuthorized(async ({ db }) => {
  // ingestion_method is the canonical "has been classified" marker; see
  // the POST handler's WHERE clause for why source_domain alone isn't.
  const [{ remaining = 0 } = { remaining: 0 }] = await db
    .select({ remaining: sql<number>`COUNT(*)` })
    .from(events)
    .where(isNull(events.ingestionMethod));
  const [{ total = 0 } = { total: 0 }] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(events);
  return NextResponse.json({
    remaining: remaining ?? 0,
    total: total ?? 0,
    pctComplete: total > 0 ? Math.round(((total - (remaining ?? 0)) / total) * 1000) / 10 : null,
  });
});
