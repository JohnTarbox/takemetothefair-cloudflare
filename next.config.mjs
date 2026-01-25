import { setupDevPlatform } from "@cloudflare/next-on-pages/next-dev";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

// Enable Cloudflare bindings in development
if (process.env.NODE_ENV === "development") {
  await setupDevPlatform();
}

export default nextConfig;
