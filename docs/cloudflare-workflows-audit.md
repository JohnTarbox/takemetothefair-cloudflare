# Cloudflare Workflows audit — inbound email handler

Scope: should `handleInboundEmail` in `mcp-server/src/email-handler.ts` be migrated to a Cloudflare Workflow? Decision-quality analysis, written after a debugging session where the existing pipeline silently swallowed AI-extract timeouts.

**Verdict (TL;DR): don't migrate now.** Reasoning + revisit criteria below.

## Current state of Workflows in this repo

Exactly one `WorkflowEntrypoint`:

- **`SchemaOrgSyncWorkflow`** (`mcp-server/src/workflows/schema-org-sync.ts:42`) — bound as `SCHEMA_ORG_SYNC` (`mcp-server/wrangler.toml`). File header (line 2) labels it **proof-of-pattern**. Coexists with the older `/api/admin/schema-org/sync` single-shot endpoint capped at 50 events to fit the 30s response budget. Triggered via `POST /api/admin/schema-org/sync-workflow/start` + status polling.

Not yet promoted to canonical; we should validate the pattern there before adopting it elsewhere.

## Current email-handler pipeline

`mcp-server/src/email-handler.ts:98` (`handleInboundEmail`) executes the following sequential stages per inbound message:

1. PostalMime parse (`email-handler.ts:135`)
2. Per-sender KV rate limit check (`email-handler.ts:167` → `checkSenderRateLimit`)
3. URL extraction from body (`email-handler.ts:200` → `pickPrimaryUrl`, pure)
4. **Fetch** the URL via main app: `GET /api/admin/import-url/fetch` (`email-handler.ts:255` → `extractEventFromUrl`)
5. **AI extract** via main app: `POST /api/admin/import-url/extract` — this calls Workers AI with a 20-second timeout (`src/lib/url-import/ai-extractor.ts:264`)
6. **Submit** the extracted event: `POST /api/suggest-event/submit` (`email-handler.ts:341` → `submitEvent`)
7. Enqueue auto-reply onto `EMAIL_JOBS` (`email-handler.ts:478` → `queueAutoReply`)

Total wall-clock typically under 30s on the happy path. The Worker invocation completes when step 7 returns; the auto-reply itself is async via the queue consumer + `env.EMAIL.send`. From the sender's perspective, end-to-end is "a few seconds" for the reply to land.

Top-level try/catch wraps everything (`email-handler.ts:113`), and every failure path writes to `error_logs` D1 with a `sessionId` for cross-step tracing (added in PR #176). Diagnostic visibility is good.

## Observed failures in the May 17 debugging session

| Failure                                                   | Frequency                             | Cause                                                                    | Would Workflows have helped?                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers AI multi-event extraction timed out after 20000ms | 2 / 5 sends                           | Model latency/load; the 20s ceiling fired before the model produced JSON | **Maybe, marginally.** `step.do` retries hit the same shared model; same overload likely produces the same timeout. Exponential backoff (10s, 20s, 40s…) could land on a less-loaded window, but the latency cost makes the auto-reply less timely. |
| No URL in body                                            | 2 / 5                                 | Sender just didn't include a link                                        | No — correct behavior, no retry needed                                                                                                                                                                                                              |
| Rate-limited sender                                       | 0 / 5 (didn't observe, but is a path) | Sender exceeded 5/24h                                                    | No — intentional silent drop, no retry                                                                                                                                                                                                              |

None of the recurrent failures are the kind Workflows are designed to fix (transient network blips, partial multi-step completion, long-running orchestration).

## Six-criterion score

Each row 0–2 points. ≥8 = strong candidate; 5–7 = worth doing eventually; <5 = leave alone.

| Criterion                                        | Score      | Reasoning                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wall-clock duration > 30s**                    | 0          | Happy path is well under 30s. AI extract is the slowest single step at 20s ceiling. We don't fight the response cap here.                                                                                                                                                                                                  |
| **Step granularity**                             | 2          | Already step-shaped (4 distinct external calls). Mapping to `step.do` is mechanical.                                                                                                                                                                                                                                       |
| **Per-step retry value**                         | 1          | Modest. Internal API calls (`/fetch`, `/extract`, `/submit`) hit the main app on the same CF infrastructure — transient blips are rare. The one place retry could help (AI extract) is bottlenecked on a shared model where retries hit the same load.                                                                     |
| **Pause/resume / waitForEvent need**             | 0          | No part of the pipeline needs to wait for human input or an external event. This would change if we added "wait for admin approval" — see "When to revisit" below.                                                                                                                                                         |
| **Observability gap**                            | 0          | Closed by PR #176. `/admin/logs` with `source LIKE 'mcp:email-handler%'` + sessionId substring search already reconstructs full email lifecycle. A Workflows dashboard would be duplicative.                                                                                                                               |
| **Migration cost** (inverted: 2 = low, 0 = high) | 1          | Class-and-step wrapping is straightforward (~150 LOC delta), but: split env between `email()` entry + Workflow class; loss of `ctx.waitUntil` semantics; need to think about instance retention (default 30 days × N emails); the schema-org Workflow is still proof-of-pattern so we'd be doubling experimental adoption. |
| **Total**                                        | **4 / 12** | Below the migrate-now threshold                                                                                                                                                                                                                                                                                            |

## What we'd actually gain

Honest tally of the upside:

1. **Free per-instance dashboard** — Cloudflare → Workflows → SCHEMA_ORG_SYNC (or new binding) shows each instance's step-by-step progress, retries, and outcome. Nice UI; not load-bearing given PR #176.
2. **Free retry config for the three internal API calls** — they'd inherit the default `limit: 5, delay: 10s, backoff: exponential` policy. If the main app burps, the workflow recovers automatically.
3. **A second proof point** for Workflows in this codebase — establishes the pattern in two places, making future migrations cheaper.

## What we'd actually lose / pay

1. **One more piece of infrastructure to think about** — class lifecycle, instance retention, dashboard navigation. Each new Workflow doubles the "where do I look first" surface.
2. **Storage cost from retained state** — default 30-day retention × instance state per email. With current low volume this is pennies, but it grows linearly with submission volume. Configurable via `retention` option on `create()` — we'd want 3–7 days, not 30.
3. **Latency under retry** — if the AI extract genuinely is slow, `step.do` retry adds 10s + 20s + 40s + 80s = ~150s before giving up. The sender's auto-reply (whether OK or extract-failed) lands later. Could mitigate with explicit `retries: { limit: 2, delay: "5s", backoff: "constant", timeout: "15s" }` per step.
4. **AI-side flakiness isn't actually retry-shaped** — the 20s timeout in `src/lib/url-import/ai-extractor.ts:264` exists _because_ Workers AI is sometimes slow under load. Retrying against the same model in the same colo within seconds is unlikely to land differently. The right fix for AI flakiness is `@cf/meta/llama-3.1-8b-instruct` → something faster, or a longer timeout, or a fallback model — not Workflow retries.

## Verdict: don't migrate now

The criteria don't justify the change. PR #176 closed the visibility gap that prompted this conversation; the remaining pain (AI flakiness) isn't retry-shaped. Migration would add a Workflow surface for benefits that are real but small at current volume.

## When to revisit (concrete triggers)

Open this doc again when _any_ of these become true:

1. **Inbound volume grows past ~50 emails/day.** At that point, the per-instance dashboard becomes genuinely useful for finding patterns across submissions, not just one email at a time.
2. **We add a pause-for-human step.** E.g., vendor application submissions that need admin approval before promoting to public — `step.waitForEvent("admin-decision", { timeout: "7 days" })` is the killer Workflows feature and nothing else in our stack does this cleanly.
3. **The Workers AI extract is replaced with a less-flaky model or external API** where transient retries genuinely help. (Reach a state where `step.do` with `limit: 3` would have rescued >50% of observed failures.)
4. **The `SchemaOrgSyncWorkflow` is promoted to canonical and we've operated it for ≥30 days.** That gives us real production data on the Workflow operational pattern and makes the second adoption cheaper.

## Better candidates for the next Workflow migration

If we want a second Workflow in production _now_, these score higher than the email handler:

- **`runScheduledRecommendationsScan`** (`mcp-server/src/index.ts:405`): already chunked with `MAX_CHUNKS=50` cursor loops against the 30s budget. Migration is "one `step.do` per chunk." Per-step retry has real value because each chunk hits the main-app API.
- **`runScheduledEventDateDrift`** (`mcp-server/src/index.ts:520`): same shape.

Both score 9–10 on the same framework. Recommended as the next candidates _after_ the schema-org workflow is promoted to canonical.

## References

- Pricing: <https://developers.cloudflare.com/workflows/reference/pricing/> (same Workers compute pricing, no per-step charge; storage GB-month with 30-day default retention)
- Retry config: <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/> (default `limit: 5, delay: 10s, backoff: exponential, timeout: 10 minutes`)
- Limits: <https://developers.cloudflare.com/workflows/reference/limits/> (50,000 concurrent instances, 10,000 steps per instance)
- `waitForEvent` API for human-in-the-loop pauses: <https://developers.cloudflare.com/workflows/build/events-and-parameters/>
