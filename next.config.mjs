import { setupDevPlatform } from "@cloudflare/next-on-pages/next-dev";

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Cloudflare Pages doesn't support Next.js image optimization by default
    // Use unoptimized for external URLs, but still get lazy loading benefits
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
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
      { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" },
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
      { source: "/api/og", headers: [cdnCache(86400)] },
    ];
  },
};

// Enable Cloudflare bindings in development
if (process.env.NODE_ENV === "development") {
  await setupDevPlatform({
    // In CI, use local-only mode to avoid needing Cloudflare auth for remote bindings (AI)
    ...(process.env.CI ? { configPath: "wrangler.ci.toml" } : {}),
  });
}

export default nextConfig;
