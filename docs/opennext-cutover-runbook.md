# OpenNext Cutover Runbook (Phase 5)

Staged cutover of the main app from the Pages project `takemetothefair`
(next-on-pages, behind the apex-worker proxy) to the Worker `meetmeatthefair-app`
(`@opennextjs/cloudflare`). Each stage has a verify + a rollback. **No stage
before Stage 4 changes what production serves.**

## Routing today (what we're changing)

```
client → meetmeatthefair.com/*  ─▶  Worker "meetmeatthefair-edge" (apex-worker)
                                     └▶ proxies UPSTREAM = takemetothefair.pages.dev (Pages)
Pages project "takemetothefair" ALSO has a custom domain on the apex, but the
wildcard Worker route BEATS it (CF tiebreak). So the apex-worker is the live edge.
```

Cutover = reassign `meetmeatthefair.com/*` from `meetmeatthefair-edge` to
`meetmeatthefair-app`, then retire the apex-worker. The Pages project + its
custom domain stay live through the soak as the rollback target.

## Pre-flight (do first, read-only)

1. `npx wrangler whoami` → confirm John Tarbox / `e6011e48…`.
2. **List zone Worker routes** (CLAUDE.md mandate) — confirm `meetmeatthefair.com/*`
   is held ONLY by `meetmeatthefair-edge`, no dangling contender:
   `npx wrangler deployments` per worker / dashboard → Workers & Pages → your zone → Routes.
3. Confirm `mmatf-isr-cache` R2 bucket exists (created 2026-06-10).
4. Confirm the migration PR (migrate/opennext) is green: typecheck/lint/tests +
   the OpenNext build + gzipped-size guard (~3.85 MiB).

## Prerequisites (before Stage 3 — the actual cutover)

- **Runtime secrets set on `meetmeatthefair-app`** (Stage 1 deploys the worker first,
  THEN set these — a worker must exist to receive secrets). Set each via
  `echo "<value>" | npx wrangler secret put <NAME>` (token from `.env`, or dashboard):
  `AUTH_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL` (= `https://meetmeatthefair.com`),
  `RESEND_API_KEY`, `INTERNAL_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `TURNSTILE_SECRET_KEY`,
  `CLAUDE_READONLY_TOKEN`, `INDEXNOW_KEY`, `CLOUDFLARE_BROWSER_RENDERING_TOKEN`,
  plus any others the Pages project has. (Values live write-only on the Pages
  project — John supplies them.)
- **INTERNAL_API_KEY must match** the value the MCP Worker expects (cross-Worker
  contract) — copy the exact prod value, don't regenerate.
- **Full functional smoke** on the workers.dev URL (Stage 1-2), incl. the
  secret-dependent + write paths (login, a test form submit, email enqueue,
  Turnstile, a middleware slug-history redirect, error.tsx returning a real 500).
  Decide first: run write-path tests against **isolated preview bindings** (a
  throwaway D1/KV/R2) vs. prod — prod writes are real.

## Staged sequence

### Stage 1 — Deploy the Worker, NO apex route (prod untouched)

- Merge `migrate/opennext` → `main` with the cutover `deploy.yml` (below). The
  `deploy-worker` job runs `opennextjs-cloudflare build` + `wrangler deploy`;
  `wrangler.toml` apex `[[routes]]` stays **commented**, so the worker lands on
  `meetmeatthefair-app.<sub>.workers.dev` only. `deploy-pages` + `deploy-apex-worker`
  still run → **production still served by Pages via the apex-worker. No change.**
- Verify: workers.dev URL serves (already proven for GET; now re-check).
- Rollback: none needed — prod unchanged.

### Stage 2 — Secrets + full smoke (still on workers.dev)

- Set all runtime secrets (above) on `meetmeatthefair-app`.
- Full smoke on workers.dev incl. write paths (isolated bindings recommended).
- Gate: every surface green, incl. `error.tsx` → HTTP 500 (OpenNext can throw
  real 500s, so the apex-worker's K1/K2 status-rewrite is no longer needed).
- Rollback: none — prod unchanged.

### Stage 3 — Claim the apex route (THE cutover)

- Uncomment the `[[routes]]` block in `wrangler.toml`:
  ```toml
  [[routes]]
  pattern = "meetmeatthefair.com/*"
  zone_name = "meetmeatthefair.com"
  ```
- Redeploy `meetmeatthefair-app` (`wrangler deploy`). This **reassigns**
  `meetmeatthefair.com/*` from `meetmeatthefair-edge` to `meetmeatthefair-app`.
  Production now served by the OpenNext Worker.
- **Do NOT delete the apex-worker or Pages project yet** — both are the rollback.
- Verify (within seconds): `curl -sI https://meetmeatthefair.com/` → 200;
  full prod smoke (home/listings/detail/sitemaps/admin-401/images/redirects);
  watch error_logs + the page-error canary + uptime monitor.
- **Rollback (fast):** remove the route from `meetmeatthefair-app` (re-comment +
  redeploy, OR dashboard → Routes → delete) → re-deploy `meetmeatthefair-edge`
  (apex-worker) to reclaim `meetmeatthefair.com/*` → traffic proxies back to Pages.
  Alternatively, deleting the new Worker's route lets the Pages custom domain serve
  directly. Pages content is current as of this deploy.

### Stage 4 — Soak (≥48h)

- Keep `meetmeatthefair-app` serving; keep Pages project + apex-worker deployable
  (rollback lever). Monitor canaries + GA4 + D1 read volume (force-dynamic pages).
- During soak, `deploy.yml` keeps deploying Pages too (rollback target stays current).

### Stage 5 — Decommission (after clean soak)

- Remove from `deploy.yml`: `deploy-pages` + `deploy-apex-worker` jobs.
- Delete the Pages project `takemetothefair` and the `meetmeatthefair-edge` Worker.
- Code cleanup (separate PRs): drop the queue-producer HTTP-proxy fallback in
  `src/lib/queues/producers.ts` (Workers producers are first-class now); optionally
  bind Workflows directly; remove `apex-worker/`.

## deploy.yml changes (Stage 1 PR)

Replace the `deploy-pages` job's build+deploy with:

```yaml
- name: Build with OpenNext
  env: { NEXT_PUBLIC_GA_ID: ..., NEXT_PUBLIC_CF_BEACON_TOKEN: ... }
  run: npx opennextjs-cloudflare build
- name: Deploy Worker
  uses: cloudflare/wrangler-action@v3
  with: { apiToken: ..., command: deploy }
```

Keep `d1-migrate`, `deploy-mcp-server`. Keep `deploy-pages` (Pages) +
`deploy-apex-worker` UNTIL Stage 5 (rollback targets). Keep the post-deploy
smoke, retargeted at the workers.dev URL in Stage 1-2, then the apex in Stage 3+.

## ci.yml changes (fold in the permanent guard)

- Replace the temporary `opennext-size-check.yml` workflow with a permanent CI
  job: `opennextjs-cloudflare build` + the `wrangler deploy --dry-run` gzipped-size
  guard (fails > ~8 MiB). This is the adapter-build + size guard the original
  audit flagged as missing.
- Keep the inverted `check-no-edge-runtime.ts` guard.
- Verify `e2e`/`smoke` jobs still work (they seed local D1 + run Playwright;
  `next dev` now calls `initOpenNextCloudflareForDev` — should be transparent).

## Key risks

- **INTERNAL_API_KEY mismatch** → cross-Worker calls (main↔MCP) 401 silently. Copy
  the exact prod value.
- **Route reassignment timing** — Stage 3 is near-instant, but verify within seconds
  and have the rollback command ready in a second terminal.
- **Write-path / ISR behavior** under load — covered by Stage 2 smoke + soak.
- **error.tsx 500s** — confirm in Stage 2 (replaces the apex-worker K2 rewrite).
