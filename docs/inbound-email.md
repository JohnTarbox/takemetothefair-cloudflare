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
                       └──> EMAIL_JOBS queue ──> Resend (auto-reply)
```

Failures (parse error, no URL, extract failure, submit failure) forward
the raw message to `SUBMIT_ADMIN_FORWARD` so nothing is silently dropped.

## One-time dashboard setup

The current `CLOUDFLARE_API_TOKEN` does not have Email Routing scope, so
these steps run in the Cloudflare dashboard (or via a token minted with
`Zone: Email Routing: Edit` + `Account: Email Addresses: Edit`).

1. **Enable Email Routing** for `meetmeatthefair.com`
   - Dashboard → Email → Email Routing → Get Started.
   - Cloudflare automatically adds the MX records and the Email Routing
     SPF include. The zone currently has no MX records, so there's no
     conflict.

2. **Verify a destination address** (must match `SUBMIT_ADMIN_FORWARD` in
   `mcp-server/wrangler.toml`)
   - Default in this repo: `jtarboxme@gmail.com`. Change the wrangler
     value first if you want failures forwarded elsewhere.
   - Cloudflare sends a confirmation link; click it from the destination
     inbox to verify.

3. **Create the route** `submit@meetmeatthefair.com → Worker`
   - Dashboard → Email → Email Routing → Routes → Create address.
   - Custom address: `submit`
   - Action: **Send to a Worker** → select `meetmeatthefair-mcp`.
   - The Worker must already be deployed with the `email()` handler
     (added in this PR) before this dropdown will accept the binding.

4. **(Optional) Catch-all** → forward unmatched addresses to the admin
   inbox so misdirected mail isn't bounced.

5. **(Optional) DMARC record** — recommended even though we only
   _receive_ at this domain. A `p=none` policy at `_dmarc.meetmeatthefair.com`
   surfaces spoofing attempts to Cloudflare without affecting deliverability.

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

Goes through the existing `EMAIL_JOBS` queue → Resend pipeline, not the
new Cloudflare Email Sending beta. Rationale: don't compound two
experimental things on a prod feature. Revisit once Email Sending is GA.

Replies are intentionally not sent to **rate-limited** senders, to avoid
creating a reflective spam vector.

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

## Verifying inbound is live

After dashboard steps 1–4 are complete and the Worker is deployed:

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
