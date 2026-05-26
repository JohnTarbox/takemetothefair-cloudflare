/**
 * Manual sweep that fills events.image_url for imageless events by
 * extracting og:image from each event's source_url.
 *
 * Phase 1 (analyst 2026-05-25):
 *   - Iterate events with NULL/empty image_url AND a non-aggregator source_url
 *   - Fetch source_url, extract og:image (fallback twitter:image)
 *   - Quality gate (content-type, content-length proxy for dimensions,
 *     URL junk patterns)
 *   - Re-host the chosen image in R2 (events/{id}/og-{ts}.{ext})
 *   - Set events.image_url to the CDN URL, record provenance in
 *     tags/source_name for follow-up audit
 *
 * Deferred to Phase 2: real dimension parsing (JPEG SOF0 / PNG IHDR);
 * web-search dead-URL fallback for source_url 404s; logo down-ranking.
 *
 * Auth: admin session OR X-Internal-Key (mirrors upload-image route).
 *
 * Budget: each call processes up to MAX_LIMIT events. Each event = 1
 * source-URL fetch + 1 image HEAD + 1 image GET. At 15s per fetch and
 * Cloudflare's 30s response budget, MAX_LIMIT=10 keeps us safe.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";
import {
  acceptCandidateImage,
  extensionForContentType,
  extractOgImage,
  fetchPageHtml,
  urlLooksLikeJunk,
} from "@/lib/og-image";
import { extractDomain, shouldIngestFromSource } from "@/lib/url-classification";
import { urlDomainClassifications } from "@/lib/db/schema";

export const runtime = "edge";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const CDN_BASE = "https://cdn.meetmeatthefair.com";
const SCRAPER_UA_FETCH_TIMEOUT_MS = 20_000; // body GET (HEAD already timed in og-image.ts)

interface EventOutcome {
  event_id: string;
  source_url: string;
  outcome:
    | "updated"
    | "would_update"
    | "skipped_no_source"
    | "skipped_aggregator"
    | "skipped_no_meta"
    | "skipped_junk_url"
    | "skipped_quality_gate"
    | "skipped_download_failed"
    | "skipped_r2_failed";
  image_url?: string;
  reason?: string;
}

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<{ ok: true; actorId: string } | { ok: false; status: number }> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return { ok: true, actorId: "internal" };
  }
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { ok: true, actorId: session.user.id };
  }
  return { ok: false, status: 401 };
}

export async function POST(request: NextRequest) {
  const env = getCloudflareEnv() as unknown as {
    INTERNAL_API_KEY?: string;
    VENDOR_ASSETS?: R2Bucket;
  };

  const authResult = await authorize(request, env);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.status });
  }
  const { actorId } = authResult;

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") || `${DEFAULT_LIMIT}`, 10)),
    MAX_LIMIT
  );
  const apply = url.searchParams.get("apply") === "true";

  const db = getCloudflareDb();

  // Candidate set: APPROVED events with no image AND a source_url. APPROVED-
  // only because filling in pending/rejected events would burn budget on
  // images that may never go public. The source_url IS NOT NULL gate skips
  // self-submitted events that have no provenance to re-fetch.
  const candidates = await db
    .select({
      id: events.id,
      sourceUrl: events.sourceUrl,
      slug: events.slug,
      name: events.name,
    })
    .from(events)
    .where(
      and(
        eq(events.status, "APPROVED"),
        or(isNull(events.imageUrl), eq(events.imageUrl, "")),
        isNotNull(events.sourceUrl),
        sql`TRIM(IFNULL(${events.sourceUrl}, '')) != ''`
      )
    )
    .orderBy(asc(events.id))
    .limit(limit);

  // Preload classification map once so we don't pay per-row.
  const classificationRows = await db
    .select({
      domain: urlDomainClassifications.domain,
      useAsTicketUrl: urlDomainClassifications.useAsTicketUrl,
      useAsApplicationUrl: urlDomainClassifications.useAsApplicationUrl,
      useAsSource: urlDomainClassifications.useAsSource,
    })
    .from(urlDomainClassifications);
  const classMap = new Map(
    classificationRows.map((r) => [
      r.domain,
      {
        useAsTicketUrl: r.useAsTicketUrl,
        useAsApplicationUrl: r.useAsApplicationUrl,
        useAsSource: r.useAsSource,
      },
    ])
  );

  const outcomes: EventOutcome[] = [];

  for (const ev of candidates) {
    const sourceUrl = ev.sourceUrl ?? "";
    if (!sourceUrl) {
      outcomes.push({ event_id: ev.id, source_url: "", outcome: "skipped_no_source" });
      continue;
    }

    if (!shouldIngestFromSource(sourceUrl, classMap)) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_aggregator",
        reason: extractDomain(sourceUrl) ?? sourceUrl,
      });
      continue;
    }

    const html = await fetchPageHtml(sourceUrl);
    if (!html) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_no_meta",
        reason: "fetch_failed",
      });
      continue;
    }

    const candidate = extractOgImage(html, sourceUrl);
    if (!candidate) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_no_meta",
        reason: "no og:image or twitter:image",
      });
      continue;
    }

    if (urlLooksLikeJunk(candidate.url)) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_junk_url",
        reason: candidate.url,
      });
      continue;
    }

    const gate = await acceptCandidateImage(candidate.url);
    if (!gate.ok) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_quality_gate",
        reason: `${gate.reason}${gate.detail ? `: ${gate.detail}` : ""}`,
      });
      continue;
    }

    if (!apply) {
      // Phase 2: when the dimension probe succeeded, surface the actual
      // measurement so an admin running the dry-run can sanity-check the
      // distribution before --apply.
      const dimsLabel = gate.dimensions
        ? `${gate.dimensions.width}x${gate.dimensions.height}`
        : "dims unknown";
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "would_update",
        image_url: candidate.url,
        reason: `${candidate.source} · ${gate.contentType} · ${dimsLabel} · ${gate.contentLength === -1 ? "unknown size" : `${gate.contentLength} bytes`}`,
      });
      continue;
    }

    // ── Apply path: download + R2 + DB update ──────────────────────
    const ext = extensionForContentType(gate.contentType);
    if (!ext) {
      // Shouldn't happen given the gate filters to known types, but
      // defend against future content-type additions.
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_quality_gate",
        reason: `no_extension_for_${gate.contentType}`,
      });
      continue;
    }

    const bucket = env.VENDOR_ASSETS;
    if (!bucket) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_r2_failed",
        reason: "VENDOR_ASSETS binding missing",
      });
      continue;
    }

    let bytes: ArrayBuffer;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SCRAPER_UA_FETCH_TIMEOUT_MS);
      try {
        const imgRes = await fetch(candidate.url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
          },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!imgRes.ok) {
          outcomes.push({
            event_id: ev.id,
            source_url: sourceUrl,
            outcome: "skipped_download_failed",
            reason: `HTTP ${imgRes.status}`,
          });
          continue;
        }
        bytes = await imgRes.arrayBuffer();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_download_failed",
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const key = `events/${ev.id}/og-${Date.now()}.${ext}`;
    try {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: gate.contentType },
        customMetadata: {
          uploadedBy: actorId,
          source: "og-image-sweep",
          originUrl: candidate.url,
          ogSource: candidate.source,
        },
      });
    } catch (e) {
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_r2_failed",
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const cdnUrl = `${CDN_BASE}/${key}`;
    try {
      await db.update(events).set({ imageUrl: cdnUrl }).where(eq(events.id, ev.id));
      await recomputeEventCompleteness(db, ev.id);
    } catch (e) {
      await logError(db, {
        message: "og-image-sweep: DB update failed (R2 has the file)",
        error: e,
        source: "og-image-sweep",
        context: { eventId: ev.id, key, candidateUrl: candidate.url },
      });
      outcomes.push({
        event_id: ev.id,
        source_url: sourceUrl,
        outcome: "skipped_r2_failed",
        reason: "db_update_failed",
        image_url: cdnUrl,
      });
      continue;
    }

    outcomes.push({
      event_id: ev.id,
      source_url: sourceUrl,
      outcome: "updated",
      image_url: cdnUrl,
      reason: `${candidate.source} · ${gate.contentType}`,
    });
  }

  const summary = {
    apply,
    scanned: candidates.length,
    updated: outcomes.filter((o) => o.outcome === "updated").length,
    would_update: outcomes.filter((o) => o.outcome === "would_update").length,
    skipped: outcomes.filter((o) => o.outcome.startsWith("skipped_")).length,
    by_outcome: outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
      return acc;
    }, {}),
  };

  return NextResponse.json({ summary, outcomes });
}
