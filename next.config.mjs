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
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
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
