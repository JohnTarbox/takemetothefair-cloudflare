# Migration: `@cloudflare/next-on-pages` (Pages) → `@opennextjs/cloudflare` (Workers)

**Status:** Planned. Feasibility spike complete (branch `spike/opennext-feasibility`, commit `7901908`).
**Why:** The Pages Function has a **25 MiB _uncompressed_** size cap and is at the redline — a +215 KiB feature PR (#432) tipped it and blocked all deploys. next-on-pages is **deprecated**. Cloudflare **Workers** cap on **gzipped** size (**10 MiB** on the paid plan this project is on) gives real headroom: the current ~23.8 MiB uncompressed worker is **~6-7 MiB gzipped**, and OpenNext bundles _smaller_ than next-on-pages. This is the durable fix that unblocks the feature backlog.

## Spike findings (confirmed, not speculation)

- `next build` **fully succeeds** under **Next 15.5.19** + **`@opennextjs/cloudflare@1.19.11`** (every route + middleware compiled).
- Required changes are **mechanical and fully enumerated** (below).
- The **only** thing that blocked a _local_ size read is **esbuild deadlocking in the dev sandbox** (a Go-threading artifact; does not occur on CI runners). The real gzipped size is confirmed in the Phase-0 CI build.

## Required changes (enumerated from the spike)

| Area              | Change                                                                                                                                                                    | Scope                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Deps              | Remove `@cloudflare/next-on-pages` (+ eslint plugin if any); add `@opennextjs/cloudflare`; bump `next` 15.1.12 → 15.5.x (OpenNext peer requires ≥15.5.18)                 | `package.json`                                                                                                           |
| Runtime API       | `getRequestContext()` → `getCloudflareContext()`; audit each for **sync vs async** mode                                                                                   | **7 files**: `src/lib/{cloudflare,auth,faq-pilot,rate-limit,turnstile}.ts`, `src/lib/email/send.ts`, `src/middleware.ts` |
| Edge decls        | Remove `export const runtime = "edge"` (Node runtime is OpenNext's default + strictly more capable)                                                                       | **261 files** + delete/replace `scripts/check-edge-runtime.ts` (it currently enforces the opposite)                      |
| Dynamic rendering | D1-reading routes must be dynamic (edge runtime made them implicitly dynamic). Add `export const dynamic = "force-dynamic"` (or async context)                            | **~160 `route.ts`** + DB-reading pages                                                                                   |
| next config       | `setupDevPlatform` → `initOpenNextCloudflareForDev`; verify `images` loader, `headers()`, `redirects()` carry over                                                        | `next.config.mjs`                                                                                                        |
| OpenNext config   | Add `open-next.config.ts` (+ optional ISR cache backend)                                                                                                                  | new file                                                                                                                 |
| Wrangler          | `main = .open-next/worker.js`; `assets = { directory: .open-next/assets, binding: ASSETS }`; keep `nodejs_compat` + all bindings (D1, KV, R2, AI, Queues)                 | `wrangler.toml`                                                                                                          |
| Pipeline          | `pages:build`/`pages deploy` → `opennextjs-cloudflare build`/`deploy`; update `deploy.yml`; add adapter-build + gzipped-size guard to `ci.yml`; drop edge-runtime CI step | `package.json`, `.github/workflows/*`                                                                                    |

## Phased execution (each phase = a reviewable PR; nothing touches prod until Phase 5)

**Phase 0 — CI size confirmation (the real go/no-go).** Clean branch off `main`; apply the mechanical changes; get a CI run that does `opennextjs-cloudflare build` and reports the **gzipped** worker size + a `wrangler deploy --dry-run`. Gate: size < ~8 MiB gzipped (headroom under the 10 MiB cap). This also closes the original audit gap (CI never ran the adapter build).

**Phase 1 — Deps & config.** Dep swaps + `next.config` + `open-next.config.ts` + wrangler shape. Local `opennextjs-cloudflare preview` smoke.

**Phase 2 — Source changes (mechanical bulk).** The 7 context swaps (audit sync/async per site — esp. `middleware.ts`'s 5 DB slug-history walks + the bearer gate), 261 edge-decl removals, `force-dynamic` markers, retire `check-edge-runtime.ts`.

**Phase 3 — Pipeline.** `deploy.yml` deploys a **Worker** (not a Pages project); `ci.yml` gains the adapter build + size guard. Build-time `NEXT_PUBLIC_*` already via GH secrets.

**Phase 4 — Deploy to a preview URL (no prod impact).** Deploy the new Worker to `*.workers.dev`. Smoke the full matrix: home / listings / detail pages / admin (auth gate 401) / API routes / **all sitemaps** / **middleware redirects (slug history)** / image rendering / rate limiting / email enqueue / claim flow / queues.

**Phase 5 — Cutover + rollback.** Flip the **apex-worker** `UPSTREAM` from `takemetothefair.pages.dev` to the new Worker (keeps its K1 status-rewrite + Location-rewrite; **instant rollback = flip `UPSTREAM` back**). Monitor canaries. Decommission the Pages project after a soak.

## Decisions needed before Phase 1

1. **ISR vs force-dynamic** for the 40 `revalidate` pages. _Recommend force-dynamic for cutover_ — the existing `Cloudflare-CDN-Cache-Control` headers (`max-age=600, stale-while-revalidate=300`) already cache responses at the CDN edge, so force-dynamic + CDN headers ≈ today's caching with bounded extra D1 load. Wire an OpenNext R2/KV ISR backend later as an optimization.
2. **apex-worker**: _Recommend keep-as-proxy_ (repoint `UPSTREAM`) for instant-rollback cutover; fold it into the Worker later. (Workers can throw real 500s, so the K2 status-rewrite becomes redundant eventually.)
3. **Worker naming / route claim** (e.g. keep `takemetothefair` as a Worker vs new name).
4. **`wrangler.toml` vs `wrangler.jsonc`** (CF guide prefers jsonc; toml works).

## Risks & mitigations

- **Middleware compat** — OpenNext runs middleware in the Worker; the 5 DB slug-history walks + bearer gate must work. _Mitigation:_ explicit Phase-4 smoke of every redirect chain. (Node-API middleware isn't supported by OpenNext, but this middleware is edge-style — fine.)
- **`headers()`/`redirects()`** — verify OpenNext honors `next.config` headers/redirects (it generally does via the worker). _Mitigation:_ Phase-4 header assertions.
- **Caching behavior change** (ISR→CDN-headers). _Mitigation:_ decision #1 + monitor D1 read volume post-cutover.
- **Rollback** — apex `UPSTREAM` flip is instant; Pages project stays live through the soak.

## Post-migration cleanup (follow-ups, not blockers)

- Remove the queue-producer HTTP-proxy fallbacks in `src/lib/queues/producers.ts` (Workers producers are first-class).
- Bind Workflows directly (Pages couldn't).
- Re-enable PR1 analytics (#432) — trivially fits once off the 25 MiB cap.
- Resume the feature backlog (PR2-PR8).
