import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // IMG1 (2026-06-07) — wired Cloudflare URL-based Image Resizing as
    // a custom Next/Image loader. Drops `unoptimized: true` (which
    // dormant'd Next's responsive srcSet) and routes every <Image src>
    // through src/lib/image-loader.ts → cdn-cgi/image/<params>/<src>.
    // Same-zone proxy, no new binding required (the upload pipeline at
    // src/lib/image-optim.ts already uses the same cf.image API in prod).
    //
    // Pre-IMG1 `hostname: "**"` was a CSRF/SSRF surface — any HTTPS host
    // could be rendered via Next/Image. Tightened to the four hosts
    // that actually appear in render-time `<Image src=...>` paths:
    //   - cdn.meetmeatthefair.com — events/vendors/venues hero + logo
    //     assets (the only column-backed image source).
    //   - meetmeatthefair.com — same-zone og-default fallback used by
    //     generateMetadata when an entity has no own image.
    //   - lh3.googleusercontent.com — Google OAuth avatar (today rendered
    //     via bare <img> at header.tsx:121, but allowlisted defensively
    //     in case a future surface uses <Image>).
    //   - graph.facebook.com — Facebook OAuth avatar, same rationale.
    loader: "custom",
    loaderFile: "./src/lib/image-loader.ts",
    remotePatterns: [
      { protocol: "https", hostname: "cdn.meetmeatthefair.com" },
      { protocol: "https", hostname: "meetmeatthefair.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "graph.facebook.com" },
    ],
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
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
      { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com https://www.google.com https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" },
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
      // Static pages — CDN caches for 1 day
      ...["/about", "/privacy", "/terms", "/faq", "/contact", "/for-vendors", "/for-promoters", "/search-visibility"].map(
        (source) => ({ source, headers: [cdnCache(86400)] })
      ),
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

// OpenNext: initialize Cloudflare bindings for `next dev` (no-ops in build).
initOpenNextCloudflareForDev();

export default nextConfig;
