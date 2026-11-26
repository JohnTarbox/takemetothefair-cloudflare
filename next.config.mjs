import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // OPE-909 — no `x-powered-by: Next.js` on responses.
  poweredByHeader: false,
  // OPE-1669 — the E2E job's `next build` (E2E_BUILD=1) skips Next's own
  // tsc pass (Next 16's build no longer runs ESLint at all, OPE-1403). The
  // Lint job already gates on both (`npm run lint`, `typecheck:all`), and Next's in-build type-check worker has no heap flag and
  // OOMs at its 4 GB default on this codebase. Every other build — the deploy's
  // OpenNext build and local `npm run build` — still runs both.
  ...(process.env.E2E_BUILD === "1"
    ? { typescript: { ignoreBuildErrors: true } }
    : {}),
  // MIG1 (2026-06-11) — force metadata to render BLOCKING, in the <head>, for
  // every client.
  //
  // Next 15.5 (which the OpenNext migration bumped us up to from 15.1) made
  // "streaming metadata" the default: for JS-rendering clients — real browsers
  // AND Googlebot — the <title>/description/canonical/OG/JSON-LD are streamed
  // late in the body and hoisted into <head> by the client. Only non-JS bots
  // (Bing, Twitterbot, facebookexternalhit, Slackbot — Next's default
  // `htmlLimitedBots` list) get blocking in-head metadata. Functionally correct,
  // but it makes our primary organic surface (~976 event + ~800 venue pages)
  // depend on Google's JS-render pass to see title/canonical, where pre-
  // migration they were always in the raw <head>.
  //
  // `htmlLimitedBots` overrides the default list with this regex: any UA that
  // matches gets blocking metadata. Matching ALL UAs disables streaming
  // entirely → metadata is always in <head>, restoring pre-15.5 behavior.
  //
  // Cost is ~zero: the detail pages are ISR-cached (`revalidate = 300`), so the
  // resolved metadata is baked into the cached HTML — blocking adds no per-
  // request latency on cache hits, only on the rare regeneration. The blocking
  // path is already proven working under OpenNext (Bing/Twitter/Slack bots get
  // full head metadata today).
  htmlLimitedBots: /.*/,
  // OPE-105 (2026-07-05) — de-blind cross-origin "Script error.". The browser
  // strips message/stack/line from a script that throws cross-origin unless the
  // tag carries `crossorigin` AND the host returns CORS headers. This stamps
  // `crossorigin="anonymous"` on every Next-emitted <script>/<link> (framework
  // chunks + next/script), so a first-party script that ever loads cross-origin
  // (a future CDN/assetPrefix move) surfaces a real error instead of the opaque
  // "Script error." Today our _next/static bundles are same-origin (no
  // assetPrefix) — first-party errors already log with full detail, so the
  // recurring `unknown#script error.` rows in error_logs are third-party/
  // extension scripts (the desired signal separation: after this, a bare
  // "Script error." is definitively NOT ours). Verified safe for the only
  // affected third-party tag (Turnstile via next/script — challenges.cloudflare
  // .com returns access-control-allow-origin:*); GA4/CF-beacon are raw <script>
  // tags the config doesn't touch.
  crossOrigin: "anonymous",
  // OPE-1565 — keep Apache ECharts OUT of the Worker server bundle. It is only
  // ever loaded in the browser (a dynamic import inside a useEffect in
  // src/components/admin/charts/EChart.tsx), but the bundler still compiles a
  // dynamic-import target into the server build: measured +508 KB raw in
  // .open-next/server-functions before this alias. On the server the entry
  // points resolve to an empty module; the import is never executed there, so
  // nothing observable changes.
  //
  // OPE-1403: Next 16 builds with Turbopack, which ignores webpack() and
  // refuses to build while one is set, so this is a Turbopack resolveAlias.
  // Every condition gets the empty stub except `browser`, which gets the real
  // file by path (an alias to the bare specifier would alias itself). These
  // five subpaths are the only echarts imports (src/components/admin/charts/
  // echarts-core.ts); zrender is reached only through them.
  turbopack: {
    resolveAlias: Object.fromEntries(
      ["core", "charts", "components", "features", "renderers"].map((sub) => [
        `echarts/${sub}`,
        { browser: `./node_modules/echarts/${sub}.js`, default: "./src/lib/empty-module.ts" },
      ]),
    ),
  },
  async redirects() {
    return [
      // Singular `/event/*` is a recurring authoring typo (the canonical
      // path is the plural `/events/*`). Without this rule the singular
      // path 404s; with it, every variant 301s into the correct page.
      // Covers the bare `/event` as well as nested segments.
      {
        source: "/event/:path*",
        destination: "/events/:path*",
        statusCode: 301,
      },
    ];
  },
  async headers() {
    // OPE-1380 — the policy below is the PUBLIC (cached/ISR) policy. Routes
    // under NONCE_CSP_PREFIXES (src/lib/csp.ts) get a per-request nonce policy
    // from middleware instead, so this one must NOT also be emitted there: two
    // CSP headers are both enforced, and the merge is the caller's problem.
    // Keep this list equal to NONCE_CSP_PREFIXES — scripts/check-nonce-csp-
    // routes.ts compiles this source and fails CI on any drift.
    const NONCE_CSP_EXCLUDED_SOURCE =
      "/((?!(?:admin|login|register|forgot-password|reset-password|verify-email|vendor|promoter|suggest-event|dashboard)(?:/|$)).*)";

    const publicCsp = {
      key: "Content-Security-Policy",
      value:
        "default-src 'self'; script-src 'self' 'unsafe-inline'" +
        (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "") +
        " https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com https://www.google.com https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    };

    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // OPE-1549 — geolocation=(self), NOT (): an empty allowlist disables the
      // Geolocation API for the whole site, whatever the user's site permission
      // says. It silently broke the Snap app's location (every upload arrived
      // location_source "none") and the public events "Near me" sort. `self` still
      // denies it to every cross-origin frame.
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
    ];

    const cdnCache = (maxAge, swr = 0) => ({
      key: "Cloudflare-CDN-Cache-Control",
      value: swr
        ? `public, max-age=${maxAge}, stale-while-revalidate=${swr}`
        : `public, max-age=${maxAge}`,
    });

    return [
      // Global security headers
      { source: "/(.*)", headers: securityHeaders },
      // Public CSP everywhere EXCEPT the nonce routes (see above). OPE-909 — no
      // 'unsafe-eval' in production (measured: zero violations on six live
      // pages without it). `next dev` evaluates modules with eval, so the dev
      // server — which is what E2E runs — keeps it; without it hydration never
      // happens and client-rendered controls never appear.
      { source: NONCE_CSP_EXCLUDED_SOURCE, headers: [publicCsp] },
      // Static pages — CDN caches for 1 day
      ...[
        "/about",
        "/privacy",
        "/terms",
        "/faq",
        "/contact",
        "/for-vendors",
        "/for-promoters",
        "/search-visibility",
      ].map((source) => ({ source, headers: [cdnCache(86400)] })),
      // Homepage — CDN caches for 10 minutes with SWR
      { source: "/", headers: [cdnCache(600, 300)] },
      // Dynamic entity pages — CDN caches for 10 minutes with SWR
      { source: "/events/:path*", headers: [cdnCache(600, 300)] },
      { source: "/venues/:path*", headers: [cdnCache(600, 300)] },
      { source: "/vendors/:path*", headers: [cdnCache(600, 300)] },
      // Public API — short CDN cache
      { source: "/api/search", headers: [cdnCache(60)] },
      // IMG1 (2026-06-07) — /api/og was retired in PR #333 to fit the
      // 25 MiB Cloudflare Worker bundle cap. The CDN cache header for
      // it has been dead-config since 2026-06-04; removed here while
      // touching the file. og:image emissions now use sized cdn-cgi
      // derivatives via cdnImage() in each entity's generateMetadata.
      // Sitemap & RSS — short CDN cache so new content appears quickly
      { source: "/sitemap.xml", headers: [cdnCache(300, 300)] },
      { source: "/blog/feed.xml", headers: [cdnCache(300, 300)] },
    ];
  },
};

// OpenNext: initialize Cloudflare bindings for `next dev` only. Guarded to
// development — calling it during a production build (CI, no Cloudflare auth)
// tries to start a remote proxy session and fails. Mirrors the original
// next-on-pages `setupDevPlatform()` dev-only guard.
//
// In CI use wrangler.ci.toml, which omits the [ai] binding: Workers AI has no
// local emulation, so its presence forces getPlatformProxy into REMOTE mode,
// which needs a Cloudflare login the CI runner doesn't have (the e2e `next dev`
// webserver died with "must be logged in to use wrangler dev in remote mode").
// Same rationale as the old setupDevPlatform({ configPath: "wrangler.ci.toml" }).
//
// OPE-1669 — E2E runs against `next start` (a production build), not `next
// dev`, so no route compiles on its first request. `next start` runs with
// NODE_ENV=production, so it opts in with E2E_LOCAL_BINDINGS=1 (set ONLY on the
// Playwright webServer command, never on `next build`, where the guard above
// still applies). Without it the server boots and every D1 read throws.
if (process.env.NODE_ENV === "development" || process.env.E2E_LOCAL_BINDINGS === "1") {
  await initOpenNextCloudflareForDev(
    process.env.CI ? { configPath: "wrangler.ci.toml" } : undefined
  );
}

export default nextConfig;
