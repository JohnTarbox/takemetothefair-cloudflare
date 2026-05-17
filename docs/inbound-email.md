# Inbound Email — `submit@meetmeatthefair.com`

Receives event submissions via email and turns them into community events
in the database (PENDING status; admin reviews before publication).

## Architecture

```
sender ──email──> Cloudflare Email Routing
                       │
                       ▼ (route: submit@ → Worker)
              meetmeatthefair-mcp (Worker)
                       │
                       ▼ email() handler
              mcp-server/src/email-handler.ts
                       │
                       ├──> POST /api/admin/import-url/fetch   (X-Internal-Key)
                       ├──> POST /api/admin/import-url/extract (X-Internal-Key)
                       ├──> POST /api/suggest-event/submit     (X-Internal-Key,
                       │                                        source: "email")
                       └──> EMAIL_JOBS queue ──> env.EMAIL.send (auto-reply
                                                  via Cloudflare Email Sending,
                                                  public beta)
```

Failures (parse error, no URL, extract failure, submit failure) forward
the raw message to `SUBMIT_ADMIN_FORWARD` so nothing is silently dropped.

## One-time dashboard setup

Routing and Sending are **two separate onboarding flows** in Cloudflare
Email Service — even though they share the same product page in the
dashboard. Both must be onboarded for end-to-end inbound + auto-reply to
work.

### A. Email Routing (inbound)

1. **Enable Email Routing** for `meetmeatthefair.com`
   - Dashboard → **Compute** → **Email Service** → **Email Routing** → Get Started.
   - Cloudflare automatically adds MX records on the apex + an SPF include.

2. **Verify a destination address** (must match `SUBMIT_ADMIN_FORWARD` in
   `mcp-server/wrangler.toml`)
   - Default in this repo: `jtarboxme@gmail.com`. Change the wrangler
     value first if you want failures forwarded elsewhere.
   - Cloudflare sends a confirmation link; click it from the destination
     inbox to verify.

3. **Create the route** `submit@meetmeatthefair.com → Worker`
   - Dashboard → Email Service → Email Routing → Routes → Create address.
   - Custom address: `submit`
   - Action: **Send to a Worker** → select `meetmeatthefair-mcp`.
   - The Worker must already be deployed with the `email()` handler
     before this dropdown will accept the binding.

4. **(Optional) Catch-all** → forward unmatched addresses to the admin
   inbox so misdirected mail isn't bounced.

### B. Email Sending (outbound auto-reply)

5. **Onboard the domain for sending**
   - Dashboard → **Compute** → **Email Service** → **Email Sending** → **Onboard Domain**.
   - Pick `meetmeatthefair.com` → **Add records and onboard**.
   - This adds a **separate** set of DNS records under `cf-bounce.meetmeatthefair.com`:
     `cf-bounce.*` MX, SPF, DKIM, plus `_dmarc.meetmeatthefair.com`.
   - These records are distinct from the Email Routing records under the
     apex. Both sets coexist because bounce-handling sits on a subdomain.
   - Wait for "Locked" status on all four records (5–15 min typically).

Skipping step 5 means the `env.EMAIL.send()` call in the queue consumer
will fail (no verified sender domain), and senders won't receive
auto-replies. Inbound still works without sending onboarded, but the UX
degrades — failure cases would still forward to admin Gmail, but the
sender gets nothing back.

## Deploy order

The route at step 3 references the Worker by name. To avoid a transient
period where mail arrives at a Worker without an `email()` handler:

1. Merge this PR.
2. Deploy the Worker (`cd mcp-server && npm run deploy`).
3. Then create the dashboard route.

## Configuration knobs

| Setting                | Where                                 | Default               | Purpose                                                                       |
| ---------------------- | ------------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `SUBMIT_ADMIN_FORWARD` | `mcp-server/wrangler.toml` `[vars]`   | `jtarboxme@gmail.com` | Failure-forwarding destination. Must be a verified Email Routing destination. |
| Per-sender rate limit  | `email-handler.ts` `PER_SENDER_LIMIT` | 5 / 24h               | Cheap abuse guard. Uses `OAUTH_KV` with key prefix `email-submit:`.           |
| Body cap fed to AI     | `email-handler.ts` `MAX_BODY_LEN`     | 50,000 chars          | Bounded so a giant signature block can't blow up the AI request.              |

## Trust model

Emails are treated as **community-tier untrusted** input:

- Submissions land as `events.status = "PENDING"` with `source: "email"`
  and `tags: ["community-suggestion", "email-submission"]`. Hidden from
  the public catalog until an admin approves.
- The pre-existing date-quality gates (`evaluateGates`) and URL
  classification gates run server-side in `/api/suggest-event/submit`.
- We do not currently match the `From:` address to a registered user
  account. A vendor sending from their account address still lands as
  PENDING — bridging that would be a Phase 2 feature.

## Auto-reply

Goes through the `EMAIL_JOBS` queue and out via the **Cloudflare Email
Sending** binding (`env.EMAIL.send()` in `mcp-server/src/queue-consumers.ts`).

- From-address: `Meet Me at the Fair <notify@meetmeatthefair.com>`
- Public-beta status: the API may change before GA. Watch the
  [Email Service changelog](https://developers.cloudflare.com/email-service/)
  for stability updates.
- Rate-limited senders are intentionally **not** auto-replied to, to
  avoid creating a reflective spam vector.

The main app (`src/lib/email/send.ts`) still uses Resend for its
password-reset / verification flows — that's a separate code path, not
affected by this consumer.

## What's deferred (Phase 2)

- **Attachment processing.** PDFs and flyer images are ignored. The OK
  and no-URL auto-replies mention this. CF Workers AI has image input,
  so OCR is feasible later.
- **Free-text AI extraction** when no URL is present. Currently we tell
  the sender to include a link.
- **HMAC-signed reply routing** (per the Cloudflare blog `email-for-agents`
  post). Only useful when we expect threaded replies.
- **Per-sender user-account matching.** Promote `From:` → `vendor` source
  when the address belongs to a registered vendor.

## Debugging a failed submission

Every step of the inbound pipeline writes to the main app's `error_logs`
D1 table via the MCP-side `logError` helper (`mcp-server/src/logger.ts`).
Rows are visible at **`/admin/logs`** in the existing admin UI.

### Trace one specific email

Each inbound message gets a `sessionId` (UUID) at the top of
`handleInboundEmail()`. That UUID is stamped into the `context` JSON of
every log row the handler writes — including helper calls into the
URL-import fetch/extract endpoints and the auto-reply enqueue.

To reconstruct one email's full trace:

1. Open `/admin/logs?source=mcp:email-handler`.
2. Find a row of interest. Expand it; the `context` JSON shows the
   `sessionId`.
3. Paste that sessionId substring into the search box (`q=` filter).
   Every log row from the same email shows up in chronological order.

### Common failure signatures

| Symptom                              | Source filter               | What the log row says                                                                                              |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sender hit rate limit (silent drop)  | `mcp:email-handler`         | "rate-limited sender; dropped without reply" (level=warn)                                                          |
| No URL in body                       | `mcp:email-handler`         | "no URL in body; sending no-url auto-reply" (level=info)                                                           |
| Workers AI extract timeout           | `mcp:email-handler:extract` | "import-url/extract reported failure" with `context.upstreamError` containing the verbatim Workers AI error string |
| URL fetched but extracted 0 events   | `mcp:email-handler:extract` | "import-url/extract returned zero events"                                                                          |
| Submit endpoint validation rejection | `mcp:email-handler`         | "submit endpoint rejected event" with `context.submitError`                                                        |
| PostalMime parse failure             | `mcp:email-handler`         | "PostalMime parse failed" with the original error in stackTrace                                                    |
| Auto-reply queue enqueue failed      | `mcp:email-handler`         | "EMAIL_JOBS.send (auto-reply enqueue) failed"                                                                      |
| Auto-reply send via env.EMAIL failed | `mcp:email-queue`           | "env.EMAIL.send failed; will retry via queue" with `context.error`                                                 |

### Other MCP areas using the same logger

Cron tasks, OAuth login failures, IndexNow helpers, and the
schema-org-sync Workflow all write to `error_logs` under the
`mcp:schedule:*`, `mcp:oauth`, `mcp:indexnow`, and `mcp:workflow:*`
source prefixes. Filter `source LIKE 'mcp:%'` to see all MCP-Worker
activity at a glance.

## Verifying inbound is live

After dashboard steps 1–5 are complete and the Worker is deployed:

1. From a personal account, send an email to `submit@meetmeatthefair.com`
   with a single URL in the body (a fair website works well, e.g.
   `https://fryeburgfair.org/`).
2. Within ~30 seconds, expect:
   - An auto-reply at your inbox.
   - A new event in `/admin/events` with status PENDING,
     tag `email-submission`, `source: "email-submission"`, and
     `suggesterEmail` populated.
3. If the auto-reply doesn't arrive:
   - Check Cloudflare → Email → Email Routing → "Activity" — was the
     message delivered to the Worker?
   - Check `wrangler tail meetmeatthefair-mcp` for `[email:submit]` log
     lines.
4. If the event doesn't appear: check `error_logs` in D1 for source
   `email:submit*`.
