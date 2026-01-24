import { setupDevPlatform } from "@cloudflare/next-on-pages/next-dev";

/** @type {import('next').NextConfig} */
const nextConfig = {};

// Enable Cloudflare bindings in development
if (process.env.NODE_ENV === "development") {
  await setupDevPlatform();
}

export default nextConfig;
