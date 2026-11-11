/**
 * OPE-1621 — `POST /api/v1/ping`: an organizer's site says a page or feed
 * changed, and we re-read it soon. Public and unauthenticated; the response is
 * always `202 {"ok":true}` (or 400 / 429). See src/lib/feed-ping.ts and
 * /help/promoter-change-ping once FEED_POLLING_ENABLED is on (draft: docs/promoter-change-ping.md).
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getBurstLimiter } from "@/lib/burst-limiter";
import { handleChangePing } from "@/lib/feed-ping";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { ctx } = getCloudflareContext();
  const db = getCloudflareDb();
  return handleChangePing(request, {
    db,
    limiter: getBurstLimiter(),
    now: new Date(),
    schedule: (work) => ctx.waitUntil(work),
    onError: (err) => {
      ctx.waitUntil(
        logError(db, {
          message: "change ping failed after the 202",
          error: err,
          source: "api:v1:ping",
        })
      );
    },
  });
}
