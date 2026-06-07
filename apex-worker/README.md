# apex Worker — `meetmeatthefair-edge`

A small Cloudflare Worker that proxies `meetmeatthefair.com` to the underlying Pages project and rewrites HTTP status from 200 to 500 when a rendered page carries the K1 FetchError marker.

This Worker exists because next-on-pages middleware can't inspect rendered responses (verified via `routes-matcher.ts:209` — middleware runs strictly before page render). See `docs/k2-spike-status-rewrite.md` for the full architecture rationale.

## Routing topology

```
client → Cloudflare edge → apex Worker (meetmeatthefair.com/*) → takemetothefair.pages.dev → Pages
```

The apex Worker claims `meetmeatthefair.com/*` via the `[[routes]]` block in `wrangler.toml`. A wildcard Worker route beats the Pages custom-domain route at the apex on Cloudflare's tiebreak (precedent: the 2026-04-25 sitemap hotfix Worker — see `CLAUDE.md`). The Pages project remains reachable at `takemetothefair.pages.dev`; the Worker proxies every request through that URL.

`mcp.meetmeatthefair.com` is unaffected — it's a separate Worker (`meetmeatthefair-mcp`) on its own subdomain.

## Behavior

| Response shape                              | Worker action                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-200 status                              | Pass through unchanged. Don't second-guess `notFound()` 404s, auth 401s, or upstream 5xx.                                                                                                         |
| Non-HTML content-type                       | Pass through unchanged. JSON / images / RSC payloads / sitemaps.                                                                                                                                  |
| HTML 200 without the K1 marker              | Pass through with body+headers preserved.                                                                                                                                                         |
| HTML 200 with `data-x-render-error="fetch"` | Rewrite status to 500. Override `Cloudflare-CDN-Cache-Control: no-store` (prevents the CDN from caching the 500 per `next.config.mjs:56-60`). Add `X-K2-Status-Rewrite: 1` for log observability. |

The Worker is stateless and idempotent — Cloudflare can re-run it freely.

## Rollback runbook

If something goes wrong post-cutover, three levels of escape:

### Level 1 — Fast: revert the route claim via dashboard

**When to use**: Worker is misbehaving (any non-`X-K2-Status-Rewrite` 500, latency spike, content drift). Fastest path; reverts in seconds without a code change.

1. Cloudflare dashboard → Workers & Pages → `meetmeatthefair-edge` → Settings → Triggers
2. Find the route `meetmeatthefair.com/*` and click **Delete**
3. Pages takes over instantly — the custom-domain route on the `takemetothefair` Pages project is the fallback (still configured, just preempted by the Worker route)
4. Verify: `curl -I https://meetmeatthefair.com/events` → expect 200, no `X-K2-Status-Rewrite` header

The Worker remains deployed (still reachable at `.workers.dev`) so a fix-then-redeploy doesn't need a fresh `wrangler deploy`.

### Level 2 — Faster: revert via code + deploy

**When to use**: dashboard access is blocked / on-call doesn't have CF credentials / want the rollback to be in git history. Slower than Level 1 by ~1 deploy cycle (~2 min).

1. Comment the `[[routes]]` block in `apex-worker/wrangler.toml`
2. Commit + push to `main` (or directly run `cd apex-worker && wrangler deploy` locally if CI is broken)
3. Cloudflare drops the route on the next Worker deploy; Pages takes over

### Level 3 — Fastest emergency: delete the Worker entirely

**When to use**: Level 1 + 2 are unavailable and you need the Worker out of the path NOW.

1. From any machine with `wrangler` auth: `wrangler delete --name meetmeatthefair-edge`
2. Worker is gone immediately; Pages serves directly with no proxy hop
3. Re-deployment requires the next `git push` to main (triggers `.github/workflows/deploy.yml`) OR a manual `cd apex-worker && npm run deploy`

This is the heavy hammer — only use if rollback by route removal somehow doesn't work.

## Verifying the cutover is healthy

After Phase C merges and deploys, run these smokes manually:

```bash
# Happy path — known-good pages return 200, no rewrite header
curl -I https://meetmeatthefair.com/events
curl -I https://meetmeatthefair.com/venues/abbot-square
curl -I https://meetmeatthefair.com/promoters/american-consumer-shows
curl -I https://meetmeatthefair.com/

# Confirm the Worker is in the path (no rewrite, but proxy works)
# These should match the pre-cutover content byte-for-byte modulo
# Cloudflare-CDN-Cache-Control overrides
curl -s https://meetmeatthefair.com/events | head -c 500
```

For the rewrite path (proves the K2 fix actually fires), the cleanest synthetic test is to wire a temporary debug-only route that throws `FetchError` from a page-level data fetcher. Curl it and verify:

- HTTP 500
- `X-K2-Status-Rewrite: 1` header present
- `Cloudflare-CDN-Cache-Control: no-store` header present
- Response body still includes the K1 marker (we don't strip it; only headers + status change)

## Observability

`X-K2-Status-Rewrite: 1` is set on every response the Worker rewrites. Future canary jobs can grep Cloudflare logs for this header to count how often the rewrite actually fires. The expected baseline is **zero or very few** per day — the rewrite only fires during real outages.

If rewrites start firing on healthy traffic, that's a high-severity signal — investigate immediately (false-positive marker emission, content drift, etc.).

## Maintenance

- **Bumping `compatibility_date`**: keep aligned with `mcp-server/wrangler.toml`. Bumping requires re-verifying behavior against a fresh `wrangler dev` smoke.
- **`UPSTREAM` env var**: if the Pages project's `.pages.dev` URL changes, update `wrangler.toml` and re-deploy.
- **Marker change**: if `src/app/error.tsx` or `src/app/global-error.tsx` change their `data-x-render-error` attribute, update `apex-worker/src/inspect.ts` AND the tests at `__tests__/inspect.test.ts` in lockstep. The unit tests are pinned to the canonical spelling.

## Related

- Code: `src/index.ts` (proxy + rewrite), `src/inspect.ts` (pure marker helper)
- Tests: `__tests__/inspect.test.ts`
- Marker source: `src/app/error.tsx` + `src/app/global-error.tsx` (`<span data-x-render-error="fetch" hidden>`)
- CI: `.github/workflows/deploy.yml` → `deploy-apex-worker` job
- Architecture context: `docs/k2-spike-status-rewrite.md`
- Plan: `/home/wa1kli/.claude/plans/lets-discuss-k2-c-d-swirling-lamport.md`
