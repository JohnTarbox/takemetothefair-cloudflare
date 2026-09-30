import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * OPE-931 — "am I running on a deployed Worker?", in ONE place.
 *
 * ## What this replaces, and why it was wrong
 *
 * `src/lib/rate-limit.ts` and `src/lib/turnstile.ts` each carried a private,
 * byte-identical copy of:
 *
 * ```ts
 * return !!(env as unknown as Record<string, unknown>).CF_PAGES;
 * ```
 *
 * `CF_PAGES` is set by **Cloudflare Pages**. This app left Pages at the
 * 2026-06-10 OpenNext cutover and runs as the `meetmeatthefair-app` **Worker**,
 * which never sets it. So both predicates returned `false` on every production
 * request — and both were consulted ONLY to decide whether to fail closed:
 *
 * - Turnstile, with no `TURNSTILE_SECRET_KEY`: would have returned
 *   `{ success: true }` — every human-verification check silently passing.
 * - Rate limiting, with no `RATE_LIMIT_KV`: would have returned
 *   `{ allowed: true }` — every limit silently passing.
 *
 * Both comments said "in production … fail closed". On Workers, neither could.
 * Neither was live, because both bindings are present — the defect was in the
 * *safety net*, waiting for the day a binding went missing.
 *
 * ## Why `DEPLOY_ENV` rather than a binding-presence check
 *
 * The obvious alternative — "am I deployed? check whether some binding exists"
 * — reintroduces the bug in a subtler form: the branch asking the question is
 * the one handling a **missing binding**, so it would be deciding how to fail
 * based on the very thing that is absent. `DEPLOY_ENV` is independent of the
 * binding being tested.
 *
 * `process.env.NODE_ENV` was the other candidate and is rejected deliberately:
 * it is `"production"` in any production *build*, including a local
 * `next build && next start`, so it answers a different question than "is this
 * the deployed Worker".
 *
 * ## The one rule this file exists to enforce
 *
 * **It is a plain `[vars]` entry in the committed `wrangler.toml`.** Per
 * OPE-284/OPE-509, `wrangler deploy` replaces the whole `[vars]` block from the
 * committed file on every deploy, so a dashboard edit cannot survive and the
 * committed line IS the live value. That is what makes this verifiable rather
 * than assumed — the failure being fixed here is precisely a predicate nobody
 * checked against a real deployed Worker.
 */
export function isDeployedEnvironment(): boolean {
  try {
    const { env } = getCloudflareContext();
    return (env as { DEPLOY_ENV?: string }).DEPLOY_ENV === "production";
  } catch {
    // Outside the Cloudflare runtime entirely (local `next build`, unit tests):
    // not deployed. Same answer the old helpers gave for this case.
    return false;
  }
}
