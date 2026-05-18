# Cloudflare Workflows audit — inbound email handler

Scope: the inbound email pipeline's use of Cloudflare Workflows, current
state after the May 2026 best-practices alignment work (PRs reshaping
the retry contract, splitting submit into checkpointed steps, dropping
the EMAIL_JOBS hop for replies, and reducing retention).

## Status

- ✅ Migrated to Workflows (commit 57afb34, May 2026)
- ✅ Submit handler split into 3 checkpointed legs (May 2026)
- ✅ NonRetryableError discipline applied (May 2026)
- ✅ Direct `env.EMAIL.send()` for auto-replies (May 2026)
- ✅ `step.waitForEvent` for correction/press intents (May 2026)
- ✅ `inbound_emails.message_id` UNIQUE for inbound idempotency (May 2026, drizzle/0073)
- ✅ Admin `/admin/inbound-emails` DLQ view + Apply/Reject/Needs-info actions (May 2026)

## Workflow inventory (MCP Worker)

| Workflow               | File                                               | Trigger           | Step shape                                                                                                                          |
| ---------------------- | -------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `inbound-email`        | `mcp-server/src/workflows/inbound-email.ts`        | per inbound email | 4 steps for support/unsubscribe/unknown; 5 + waitForEvent for correction/press; 7 for submit (3 sub-steps for fetch/extract/submit) |
| `schema-org-sync`      | `mcp-server/src/workflows/schema-org-sync.ts`      | admin POST        | per-event loop                                                                                                                      |
| `recommendations-scan` | `mcp-server/src/workflows/recommendations-scan.ts` | cron `0 6 * * *`  | per-chunk loop                                                                                                                      |
| `event-date-drift`     | `mcp-server/src/workflows/event-date-drift.ts`     | cron `0 6 * * *`  | per-chunk loop                                                                                                                      |

Pages can't host workflows (`feedback_pages_cant_bind_to_workers.md`);
all four live in the MCP Worker. Main app reaches `schema-org-sync` via
an HTTP escape hatch at `/api/admin/workflows/schema-org-sync/*`.

## Retry contract

Handlers and submit-leg functions throw on failure:

- **Plain `Error`** — transient failure (5xx, network, AI overload).
  The workflow step's `retries` config fires with the configured backoff.
- **`NonRetryableError`** (from `cloudflare:workflows`) — permanent
  failure (4xx, validation, missing input). The step skips retries and
  propagates immediately.

The workflow's outer try/catch records the final error in
`inbound_emails.error` and sets `status='failed'`. Per-step retry config
is now load-bearing — the previous pattern of handler-catches that
returned `{status:"failed"}` made the retry budget dead code.

| Step                           | Retry budget              | Why                                                                                                       |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `mark-processing`, `mark-done` | limit:1, 5s, constant     | tight; D1 UPDATEs                                                                                         |
| `dispatch` (non-submit)        | limit:2, 10s, constant    | one retry on transient main-app issues                                                                    |
| `submit/load-row`              | limit:2, 5s, constant     | D1 read                                                                                                   |
| `submit/fetch-url`             | limit:3, 5s, exponential  | network + main-app 5xx covered                                                                            |
| `submit/ai-extract`            | limit:1, 10s, constant    | Workers AI load-timeouts don't recover on tight retries (May 17 finding); throws NonRetryableError anyway |
| `submit/submit-event`          | limit:3, 5s, exponential  | network + main-app 5xx covered                                                                            |
| `send-reply`                   | limit:3, 10s, exponential | covers `env.EMAIL.send` transients                                                                        |

## Retention

All `.create()` call sites pass `retention: { successRetention: "7 days",
errorRetention: "7 days" }`. Default would be 30 days. Trade-off: enough
post-mortem window for a failure cluster without growing instance state
storage linearly with volume.

## Direct send vs. queue

Inbound-email auto-replies use `env.EMAIL.send()` directly inside the
`send-reply` step. The previous `EMAIL_JOBS` queue hop is preserved for
future batched outbound (campaigns, digests) but no longer in the
inbound-reply path. Rationale: Workflow steps already give durability;
the queue intermediate added a failure mode without buying anything.

## Human-in-the-loop pause (correction/press)

For the `correction` and `press` intents, the workflow pauses on
`step.waitForEvent("admin-decision", { type: "admin-decision",
timeout: "7 days" })` after dispatch. Admin resolves via
`/admin/inbound-emails` → Apply / Reject / Needs info button, which
POSTs to `/api/admin/inbound-emails/decide` (main app) → proxies to
`/api/admin/inbound-emails/:rowId/decide` (MCP) →
`instance.sendEvent({type:"admin-decision", payload})`.

Decision actions map to reply kinds in `decisionToReplyKind`:

| Intent     | Action          | ReplyKind                  |
| ---------- | --------------- | -------------------------- |
| correction | applied         | `correction-applied`       |
| correction | rejected        | `correction-rejected`      |
| correction | needs-more-info | `correction-needs-info`    |
| correction | (7d timeout)    | `correction-ack` (generic) |
| press      | applied         | `press-handled`            |
| press      | needs-more-info | `press-needs-info`         |
| press      | (7d timeout)    | `press-ack` (generic)      |

The optional `note` from the admin is included verbatim in the
sender-visible reply text for the applied/rejected/needs-info kinds.

## Sweep-workflow contract (May 2026)

All four workflows now share the same failure contract:

- **5xx / network** inside a step body → plain `Error` → step.do retries
  per its configured budget (`limit: 2` for sweeps, varies for email legs).
- **4xx** inside a step body → `NonRetryableError` → step skips retries.
- **Logging lives in the OUTER catch**, not inside the step body. Per CF
  Workflows rules-of-workflows (side effects repeat on restart), logging
  from inside a step body that's about to be retried produces duplicate
  log entries. Moving `logError` to the outer catch guarantees one log
  per terminal failure.
- For sweeps (chunked), the outer catch logs + breaks the loop. For
  schema-org-sync's per-event mode, it logs + continues to the next event.
  One bad chunk doesn't kill the next day's cron — tomorrow's run starts
  from cursor=0 again.

## Open follow-ups

- Bounce/complaint inbound handling — would be a new `bounce@` intent.
- Removing `EMAIL_JOBS` queue + consumer entirely is deferred — kept
  for future batched-outbound use cases.

## References

- Cloudflare Workflows docs: <https://developers.cloudflare.com/workflows/>
- `NonRetryableError` import: `cloudflare:workflows` (NOT `cloudflare:workers`)
- Limits: <https://developers.cloudflare.com/workflows/reference/limits/>
- Step output max: 1 MiB JSON-serialized (we cap fetched content at 100 KB)
- Retention: 3-30 day range; we use 7 to balance debuggability and cost
