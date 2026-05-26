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
import { NextRequest, NextResponse } from "next/server";
import { eq, isNull, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { classifySource, type IngestionMethod } from "@/lib/source-classification";

export const runtime = "edge";

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

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<boolean> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return true;
  }
  const session = await auth();
  return session?.user?.role === "ADMIN";
}

export async function POST(request: NextRequest) {
  const env = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (!(await authorize(request, env))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "true";
  const limitParam = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const db = getCloudflareDb();
  try {
    // Rows still missing one of the two new columns. The OR guards against
    // partially-backfilled state (e.g., a prior run set sourceDomain but
    // not ingestionMethod for rows where the URL was parseable but the
    // method couldn't be inferred until a code update).
    const candidates = await db
      .select({
        id: events.id,
        sourceName: events.sourceName,
        sourceUrl: events.sourceUrl,
      })
      .from(events)
      .where(or(isNull(events.sourceDomain), isNull(events.ingestionMethod)))
      .limit(limit);

    const outcomes: Outcome[] = [];
    let written = 0;
    for (const row of candidates) {
      const classification = classifySource(row.sourceName, row.sourceUrl);
      const changed =
        classification.sourceDomain !== null || classification.ingestionMethod !== null;
      outcomes.push({
        id: row.id,
        sourceName: row.sourceName,
        sourceUrl: row.sourceUrl,
        sourceDomain: classification.sourceDomain,
        ingestionMethod: classification.ingestionMethod,
        changed,
      });
      if (apply && changed) {
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
}

// Counts remaining work. Cheap; no writes.
export async function GET(request: NextRequest) {
  const env = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (!(await authorize(request, env))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getCloudflareDb();
  const [{ remaining = 0 } = { remaining: 0 }] = await db
    .select({ remaining: sql<number>`COUNT(*)` })
    .from(events)
    .where(or(isNull(events.sourceDomain), isNull(events.ingestionMethod)));
  const [{ total = 0 } = { total: 0 }] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(events);
  return NextResponse.json({
    remaining: remaining ?? 0,
    total: total ?? 0,
    pctComplete: total > 0 ? Math.round(((total - (remaining ?? 0)) / total) * 1000) / 10 : null,
  });
}
