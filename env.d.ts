/**
 * OPE-906 — process.env shape only.
 *
 * The `CloudflareEnv` interface that used to live here is now GENERATED from
 * the real wrangler config into `cloudflare-env.d.ts` (`npm run cf:typegen`).
 * Two hand-written partial copies of it — here and in `src/env.d.ts` — merged
 * with each other and drifted from the bindings they claimed to describe.
 *
 * These NodeJS.ProcessEnv entries stay hand-written on purpose: they are
 * build-time/runtime Node env vars, not Cloudflare bindings, so `wrangler
 * types` has nothing to say about them.
 */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NEXTAUTH_SECRET: string;
      NEXTAUTH_URL: string;
      AUTH_SECRET: string;
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      FACEBOOK_CLIENT_ID?: string;
      FACEBOOK_CLIENT_SECRET?: string;
    }
  }
}

export {};
