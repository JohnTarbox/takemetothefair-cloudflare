export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { pingIndexNow } from "@/lib/indexnow";

// `source` is optional and free-form so callers can label the lifecycle event
// (e.g. "event-approve", "vendor-create"). Falls back to "internal-api" for
// legacy callers that don't set one.
const bodySchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10_000),
  source: z.string().min(1).max(64).optional(),
});

/**
 * POST /api/internal/indexnow
 * Internal endpoint for the MCP server (and other Workers) to trigger an
 * IndexNow ping. Auth: X-Internal-Key header (now via withInternalKey, which
 * does a constant-time compare — replaces the prior timing-unsafe `!==`. The
 * 401 body normalized to `{ error: "Unauthorized" }`; callers key off
 * response.ok, not the body, so this is internal-only and inert in practice).
 *
 * REL4 (2026-06-13): this endpoint propagates the TRUE Bing outcome. It used to
 * always return `{ success: true }` 200 even when Bing 429'd, which let the MCP
 * `flush_pending_search_pings` mark its outbox rows flushed on a throttled batch
 * — silently dropping every URL. We now return a non-2xx (502) with the real
 * Bing HTTP status when the submission failed, so the flush treats it as a
 * failure and leaves the rows pending for a later cron. Inline fire-and-forget
 * callers (`triggerIndexNow`) ignore the body as before.
 */
export const POST = withInternalKey(async ({ request, db }) => {
  const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "invalid_payload" }, { status: 400 });
  }

  const result = await pingIndexNow(
    db,
    parsed.data.urls,
    env,
    parsed.data.source ?? "internal-api"
  );
  return NextResponse.json(
    {
      success: result.ok,
      // OPE-73: true when the circuit breaker (operator pause / cooldown) skipped
      // Bing entirely — a clean deferral, NOT a failure. The MCP flush leaves its
      // rows pending WITHOUT logging an error when this is set.
      deferred: result.deferred,
      count: parsed.data.urls.length,
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
      indexnow_http_status: result.httpStatus,
      error: result.ok ? undefined : (result.failureReason ?? "indexnow_submission_failed"),
    },
    // 200 on success. A breaker DEFERRAL (operator pause / cooldown skipped Bing)
    // returns 503 — non-2xx so the flush leaves its rows pending, but distinct so
    // the flush does NOT log it as an error (OPE-73: stops the hourly 502 noise a
    // paused kill-switch produced). A genuine upstream (Bing) rejection returns
    // 502 so the flush logs it + leaves the rows pending.
    { status: result.ok ? 200 : result.deferred ? 503 : 502 }
  );
});
