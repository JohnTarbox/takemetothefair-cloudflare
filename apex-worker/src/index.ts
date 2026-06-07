/**
 * K2 Phase B (2026-06-07): apex Worker that proxies meetmeatthefair.com
 * to the underlying Pages project and rewrites HTTP status to 500 when
 * the rendered HTML carries the K1 FetchError marker.
 *
 * Why this Worker exists
 * ----------------------
 * The K2 spike (docs/k2-spike-status-rewrite.md) verified that
 * Next.js 15 App Router has no canonical way for a Server Component
 * throw to produce HTTP 500 while still rendering error.tsx. Next.js's
 * framework-recognized status sentinels hardcode {401, 403, 404} —
 * 500 is not a member. The next-on-pages runtime
 * (node_modules/@cloudflare/next-on-pages/templates/_worker.js/routes-matcher.ts:209)
 * runs middleware strictly BEFORE the page renders, so middleware
 * can't inspect the rendered body to rewrite status post-hoc.
 *
 * The remaining viable path: a separate Worker that sits in front of
 * Pages, proxies every request, and rewrites status based on the
 * rendered body. That's this file.
 *
 * Routing model
 * -------------
 * Phase B (PR 2): no route claim — verified at
 *   https://meetmeatthefair-edge.<account>.workers.dev
 *
 * Phase C (PR 3): wrangler.toml uncomments the [[routes]] block to
 * claim meetmeatthefair.com/*. A wildcard Worker route beats the
 * Pages route at the apex on Cloudflare's tiebreak (precedent: the
 * 2026-04-25 sitemap hotfix Worker, documented in CLAUDE.md).
 *
 * After Phase C, requests flow:
 *   client → Cloudflare edge → apex Worker → takemetothefair.pages.dev → Pages
 *
 * Behavior
 * --------
 * For every request:
 *   1. Proxy to env.UPSTREAM (configured in wrangler.toml).
 *   2. If response is not 200 or not HTML, pass through unchanged.
 *   3. Buffer the body and scan for the K1 marker.
 *   4. If marker absent, pass body+headers+status through unchanged.
 *   5. If marker present, rewrite to 500 + override cache-control so
 *      the CDN doesn't cache the 500.
 *
 * Cache-control override is critical: next.config.mjs sets
 * Cloudflare-CDN-Cache-Control: public, max-age=600 on /events,
 * /venues, /vendors, and /. Without an explicit no-store override on
 * the rewritten response, the CDN would cache the 500 for the full
 * 10-minute TTL even after the underlying DB recovers.
 *
 * The X-K2-Status-Rewrite: 1 header is added for log observability —
 * future canary jobs can grep Cloudflare logs for this header to
 * count how often the rewrite actually fires.
 *
 * Performance
 * -----------
 * Body buffering (await response.text()) is the simplest correct
 * approach. Average page is 50-200 KB; well under Worker memory caps
 * (Cloudflare Workers have a 128 MB memory cap per request). The cost
 * is one extra full-body read on every HTML response — measured impact
 * to TTFB ~10-30ms depending on page size. If perf becomes an issue at
 * our scale, a streaming HTMLRewriter pass could replace the buffer
 * (but HTMLRewriter is one-pass and doesn't let us decide status after
 * the marker is seen mid-stream, so the buffered approach is simplest
 * to reason about).
 */

import { hasErrorMarker } from "./inspect";

export interface Env {
  /** Full URL of the Pages project to proxy to.
   *  Phase B default: https://takemetothefair.pages.dev */
  UPSTREAM: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Build the upstream URL from the incoming path + query, preserving
    // the original method, headers, and body. The Request constructor
    // copies all those attributes from `request` when we pass it as
    // the init argument.
    const url = new URL(request.url);
    const upstreamUrl = new URL(url.pathname + url.search, env.UPSTREAM);
    const upstreamReq = new Request(upstreamUrl.toString(), request);

    const response = await fetch(upstreamReq);

    // Only inspect HTML 2xx responses. We deliberately don't second-
    // guess non-200 responses (those are intentional, e.g. 404 from
    // notFound() or 401 from auth gates) or non-HTML responses
    // (JSON / images / RSC payloads / sitemaps).
    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");
    if (response.status !== 200 || !isHtml) {
      return response;
    }

    // Buffer the body. We need to scan the whole thing to make the
    // status decision before sending headers, and re-emitting requires
    // the body anyway.
    const body = await response.text();

    if (!hasErrorMarker(body)) {
      // Happy path — pass through. Reconstruct the response with the
      // body we already read (the original body stream is consumed).
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Marker found — rewrite status + override cache-control.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    // Observability marker: future canary jobs can grep Cloudflare
    // logs / response samples for X-K2-Status-Rewrite to track how
    // often the rewrite fires.
    headers.set("X-K2-Status-Rewrite", "1");

    return new Response(body, {
      status: 500,
      statusText: "Internal Server Error",
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
