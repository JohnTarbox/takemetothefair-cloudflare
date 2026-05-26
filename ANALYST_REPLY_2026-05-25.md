# Reply to the analyst — three-item cluster (2026-05-25)

Hi —

All three items shipped today plus the layout follow-ups and the Bing sitemap resubmit. Six commits on `main`, all green deploys. Confirmations answered inline.

## Quick confirmations (your tail questions)

| Q                                                    | Status           | Evidence                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug validation at write time, not just data cleanup | **Yes**          | Three-layer defense in `CLAUDE.md` §"Slug typing (#120 prevention)": branded `Slug` type from `createSlug()`, schema columns typed `.$type<Slug>()`, ESLint `no-restricted-syntax` rejecting hand-rolled regex |
| `/event/` → `/events/` is 301 not 302                | **Yes, 301**     | `next.config.mjs:22-26` — `statusCode: 301`, covers bare `/event` and all `:path*` segments                                                                                                                    |
| Segmented sitemap index resubmitted to Bing + GSC    | **Both yes now** | GSC: children submitted 2026-05-22 (0 errors). Bing: all three sitemaps explicitly submitted today 18:19-18:21 UTC via the new endpoint below                                                                  |

## Item 3 — `/admin/analytics` (taken first per your order)

**Data bugs (commit `ebc776f`).**

- The window mismatch: `loadBrandVsNonBrand` was calling `getSiteSearchQueries(env, { rowLimit: 500 })` without a `dateRange`, which defaults to `last_28d` regardless of dashboard window. Now takes `days` and maps to GSC preset (`last_7d` / `last_28d` / `last_90d`) or custom range. That's why 7d-window Google clicks read 25 but Brand-vs-Non-Brand summed to 53.
- The 90-day-equals-30-day perception: the 90d query is actually correct (`loadKpiStrip90d` passes `since90 = now − 90d` and `days = 90` to the loader). The `Conversions` and `Publishing` tables just don't have 90 days of data — older buckets fill with zeros, so totals match. I added a JSX comment + explicit source labels (`source: GSC` / `source: D1 analytics_events` / `source: D1 indexnow_submissions`) on all six sparkline cards so this is interpretable from the dashboard alone.
- Search visibility 377 (30d) vs 408 (90d): correct GSC data, just needed clearer titles. Both cards now say "last Nd" and call out the source.

**Layout (commit `1332f97`).**

- Renamed the two "Recent activity" cards so they're distinguishable: top one is now `Admin actions (N last 7 days · source: admin_actions)`; bottom is `Activity feed (current window · mixed sources)`.
- Added a status legend at page bottom: ◯ on target · ⚠ below target · ⛔ action required · 🕒 data feed stale.
- Recommendations card refocused. Headline is now `actionableCount` (red + T1/T2 yellow), not raw `totalItems`. Raw total kept in the footer. Computed via `tierFor()` per item in `loadRecommendationsSummary`. At today's 3,851 active items this drops the headline to whatever T1/T2-only sums to (probably 40-100), which actually matches the dashboard's purpose.

**Deferred (separate larger PR):** hierarchy / top-section P0 emphasis / 30-90 chart window-toggle / vanity-card demotion. Those need design input plus a refactor of the current flat KPI grid — bigger than a hotfix.

## Item 2 — Recommendation rules

**Shipped in one commit (`6ab79b6`).**

- `enhanced_profile_cohort` (was T1 / 259 items): repurposed as **reachable-unclaimed-with-upcoming-event outreach**. Drops the no-logo filter (you were right, 99.8% of vendors match it — tautology not a signal). New criteria: `claimed=0` AND has APPROVED upcoming event AND `contact_email` non-empty. Re-tiered out of T1 (now falls through to T3 default, since the action is claim conversion not direct Enhanced Profile sale). `autoResolve: true` handles the cohort swap on next scan.
- `low_ctr_pages`: tightened position threshold from `≤10` to `≤5` (only top-5 is genuinely "winning rank"), raised impression floor from `10` to `50`. Updated rationale text + title to match.
- `seo_position_11_20`: raised impression floor from `10` to `25` (middle of your 20-30 suggestion).
- **Cross-cutting GSC slug resolution**: new helper `src/lib/recommendations/resolve-gsc-path.ts` walks `event_slug_history` / `blog_slug_history` / `vendor_slug_history` (max 5 hops, cycle-detected). Both GSC-driven rules now resolve `topPagePath` through it before emitting, so rec cards link to live canonical URLs rather than 301-redirecting historical ones.

Tier test (`tiers.test.ts`) updated to assert `enhanced_profile_cohort` now resolves to T3.

## Item 1 — Automated event image sourcing (Phase 1)

**Shipped in one commit (`7f0ac0b`).**

Phase 1 deferral pattern applied — ship the working pipeline without the highest-risk components. Reasoning: the dead-URL web-search fallback and real dimension parsing are each their own subproblem with their own failure modes; we should see actual og:image yield before adding more moving parts.

**What's in:**

- `src/lib/og-image.ts`:
  - `extractOgImage()`: og:image (preferred) → twitter:image (fallback), both attribute orders, single + double quotes, relative URL resolution, data: URI rejection. 13 unit tests cover the regex matrix.
  - `urlLooksLikeJunk()`: pre-fetch blacklist — Google Calendar buttons, doubleclick, googlesyndication, 1x1.gif / spacer.gif / pixel.gif patterns.
  - `acceptCandidateImage()`: HEAD-based gate. Content-Type filter (jpg/png/webp; SVG excluded since most og:image SVGs are logos). Content-Length ≥ 15KB as a heuristic proxy for "≥ 600px long edge" — JPEG/PNG at that resolution typically exceed 15KB; favicons sit at 2-5KB; tracking pixels < 1KB.
- `POST /api/admin/og-image/sweep?limit=N&apply=true|false`:
  - Admin session OR X-Internal-Key auth.
  - Default `apply=false` (dry-run) so you can preview before writing.
  - Selects APPROVED imageless events with non-empty `source_url`, gates each through `shouldIngestFromSource` (skips aggregator domains by table, not hardcoded list).
  - On accept: downloads, puts to R2 at `events/{id}/og-{ts}.{ext}`, updates `events.image_url` to `cdn.meetmeatthefair.com` URL, recomputes completeness.
  - Per-event outcome detail in response so you can see what was accepted vs skipped and why.
  - `limit ≤ 10` keeps total fetch time inside Cloudflare's 30s response cap.

**Deferred to Phase 2:**

- Real dimension parsing (JPEG SOF0 / PNG IHDR / WebP VP8X) replacing the content-length proxy.
- Web-search dead-URL fallback when `source_url` 404s.
- Explicit logo down-ranking (currently only filtered via SVG exclusion).
- Wiring to the MCP worker's daily cron — want per-event budget data from the manual sweep first.

**Recommended next move:** trigger a dry-run at `limit=10` to see the yield distribution. Hit `/api/admin/og-image/sweep?limit=10` (POST, admin auth). If the outcomes look reasonable, run `?limit=10&apply=true` repeatedly to chew through the queue.

## Bonus — Bing sitemap submit

Your Q3 turned up `submitted: null / lastCrawled: null` from Bing on the segmented index. The existing `resubmit_sitemap` MCP tool was Google-only by design — the `bing-webmaster.ts` wrapper had no `SubmitFeed` support. Added it in `087e551`:

- `submitFeed(env, feedUrl)` in `bing-webmaster.ts`
- `POST /api/admin/analytics/bing-sitemap-submit` (admin session or X-Internal-Key)

All three sitemaps explicitly resubmitted today 18:19-18:21 UTC: `sitemap.xml`, `sitemap-events.xml`, `sitemap-static.xml`. After Bing's 60-min cache TTL, `get_bing_sitemaps` should reflect non-null `submitted`/`lastCrawled` timestamps matching GSC's state.

## Commit list

| SHA       | Item                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| `ebc776f` | Item 3 data — Brand vs non-brand honors dashboard window, sparkline source labels |
| `6ab79b6` | Item 2 — three rec rules + GSC slug-history resolver                              |
| `7f0ac0b` | Item 1 Phase 1 — og:image sweep endpoint + extractor + 13 tests                   |
| `1332f97` | Item 3 layout partial — dedup activity titles, KPI legend, actionable rec count   |
| `087e551` | Bing `submitFeed` + admin route                                                   |

Thanks for the audit. The `enhanced_profile_cohort` no-logo filter being a 99.8% tautology was a useful catch — that's a class of bug worth looking for elsewhere (any rule whose failing branch covers >95% of rows is doing zero work).
