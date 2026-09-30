import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";

// ISR cache backend (John's call: preserve ISR): rendered ISR output is cached
// in R2 under `NEXT_INC_CACHE_R2_BUCKET`, and a stale entry is revalidated
// through OpenNext's Durable Object queue — the setup OpenNext recommends for
// production (R2 incremental cache + DO queue; a D1 tag cache only once
// on-demand revalidation exists, and this app has none).
//
// OPE-899 (2026-09-13) replaced `queue: "direct"`, which OpenNext documents as
// debug-only. Its comment justified it with CDN `stale-while-revalidate`
// headers, but public HTML is served `private, no-cache, no-store` (OPE-332
// governs that), so no CDN was serving stale.
//
// ⚠️ What this queue does TODAY, measured rather than assumed: nothing. The
// build prerenders only `/favicon.ico` and `/llms.txt` (both `revalidate:
// false`, never stale) plus the 500 page, and `dynamicRoutes` is empty — every
// `[slug]` page with `export const revalidate` also calls `auth()`, which makes
// it dynamic, so `revalidate` there is inert and no response carries
// `x-nextjs-cache`. The R2 bucket holds exactly those three entries per build
// id, written at deploy, none at request time. The queue becomes live the day a
// page renders without request data; this makes that day correct by default.
//
// The DO needs `NEXT_CACHE_DO_QUEUE` (class `DOQueueHandler`, exported by
// OpenNext's worker template) and the `WORKER_SELF_REFERENCE` service binding —
// both in wrangler.toml.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: doQueue,
});
