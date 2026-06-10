import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

// ISR cache backend (John's call: preserve ISR). The `revalidate` `[slug]`
// detail pages (events/vendors/venues/promoters/blog) render on-demand — no
// generateStaticParams anywhere, so nothing prerenders at build — and their
// rendered output is cached in R2 keyed per route, revalidated on the
// `revalidate` interval. The static-shell D1 pages (home, listings, admin,
// dashboard) are `force-dynamic` instead (they can't prerender without
// bindings) and rely on the existing Cloudflare-CDN-Cache-Control headers.
//
// Requires an R2 bucket bound as `NEXT_INC_CACHE_R2_BUCKET` (wrangler, Phase 3).
//
// queue: "direct" — revalidation runs inline on the stale request rather than
// via a Durable Object queue. Acceptable here because the CDN headers carry
// `stale-while-revalidate`, so the CDN serves stale while the origin
// revalidates; this avoids standing up a new Durable Object. The app uses no
// on-demand revalidation (revalidateTag/revalidatePath), so no tag cache is
// needed.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: "direct",
});
