/**
 * IndexNow protocol — instant URL submission to participating search engines
 * (Bing, Yandex, Seznam, Naver). Single endpoint, fire-and-forget.
 *
 * Spec: https://www.indexnow.org/documentation
 *
 * Set INDEXNOW_KEY as a Cloudflare Worker secret. The key file is served at
 * the SITE ROOT (https://meetmeatthefair.com/<key>.txt) by
 * src/app/[indexnowKey]/route.ts. Root location matters: per the spec, a key
 * file's path scope authorizes only URLs under that path. Serving from a
 * subdirectory (e.g. /api/indexnow-key/) caused IndexNow to reject all
 * /blog/, /events/, /venues/ submissions with HTTP 422.
 *
 * NEVER throws to the caller. Logs success/failure to console for wrangler
 * tail observability AND persists every attempt to the indexnow_submissions
 * table for the /admin/analytics → IndexNow tab.
 */

import { indexnowSubmissions } from "@/lib/db/schema";
import { lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { SITE_HOSTNAME } from "@takemetothefair/constants";

const HOST = SITE_HOSTNAME;
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_BATCH_SIZE = 10_000;

function keyLocation(key: string): string {
  return `https://${HOST}/${key}.txt`;
}

interface IndexNowEnv {
  INDEXNOW_KEY?: string;
}

type Db = DrizzleD1Database<Record<string, unknown>> | null;

type SubmissionStatus = "success" | "failure" | "no_key" | "no_eligible_urls";

async function recordSubmission(
  db: Db,
  source: string,
  urls: string[],
  status: SubmissionStatus,
  httpStatus: number | null,
  errorMessage: string | null
): Promise<void> {
  if (!db) return;
  try {
    await db.insert(indexnowSubmissions).values({
      timestamp: new Date(),
      source,
      urls: JSON.stringify(urls),
      urlCount: urls.length,
      status,
      httpStatus: httpStatus ?? undefined,
      errorMessage: errorMessage ?? undefined,
    });

    // 1% probabilistic cleanup of submissions older than 30 days
    if (Math.random() < 0.01) {
      const thirtyDaysAgo = new Date(Date.now() - 2592000 * 1000);
      await db.delete(indexnowSubmissions).where(lt(indexnowSubmissions.timestamp, thirtyDaysAgo));
    }
  } catch (err) {
    // Never throw from the logger
    console.error("[IndexNow] Failed to persist submission record:", err);
  }
}

export async function pingIndexNow(
  db: Db,
  urls: string | string[],
  env: IndexNowEnv,
  source: string
): Promise<void> {
  const key = env.INDEXNOW_KEY;
  const list = Array.isArray(urls) ? urls : [urls];
  const filtered = list
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u && u.startsWith(`https://${HOST}/`)));

  if (!key) {
    console.warn("[IndexNow] INDEXNOW_KEY not configured — skipping ping");
    await recordSubmission(db, source, filtered, "no_key", null, null);
    return;
  }

  if (filtered.length === 0) {
    await recordSubmission(db, source, [], "no_eligible_urls", null, null);
    return;
  }

  try {
    if (filtered.length === 1) {
      const qs = new URLSearchParams({
        url: filtered[0],
        key,
        keyLocation: keyLocation(key),
      });
      const response = await fetch(`${INDEXNOW_ENDPOINT}?${qs.toString()}`, {
        method: "GET",
      });
      const body = response.ok ? "" : (await response.text()).slice(0, 200);
      console.log(`[IndexNow] GET ${filtered[0]} → ${response.status}${body ? " " + body : ""}`);
      await recordSubmission(
        db,
        source,
        filtered,
        response.ok ? "success" : "failure",
        response.status,
        response.ok ? null : body || `HTTP ${response.status}`
      );
      return;
    }

    // Batch up to MAX_BATCH_SIZE per request
    for (let i = 0; i < filtered.length; i += MAX_BATCH_SIZE) {
      const chunk = filtered.slice(i, i + MAX_BATCH_SIZE);
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: HOST,
          key,
          keyLocation: keyLocation(key),
          urlList: chunk,
        }),
      });
      const body = response.ok ? "" : (await response.text()).slice(0, 200);
      console.log(
        `[IndexNow] POST ${chunk.length} URLs → ${response.status}${body ? " " + body : ""}`
      );
      await recordSubmission(
        db,
        source,
        chunk,
        response.ok ? "success" : "failure",
        response.status,
        response.ok ? null : body || `HTTP ${response.status}`
      );
    }
  } catch (error) {
    console.error("[IndexNow] Network error:", error);
    const message = error instanceof Error ? error.message : String(error);
    await recordSubmission(db, source, filtered, "failure", null, message);
  }
}

/** Construct the canonical public URL for a content slug. */
export function indexNowUrlFor(
  kind: "events" | "venues" | "vendors" | "blog",
  slug: string
): string {
  return `https://${HOST}/${kind}/${slug}`;
}
