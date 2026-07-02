# OPE-66 — GA4 claim-funnel custom dimensions (operator runbook)

**Filed:** 2026-07-02 alongside the help/claim program (spec §6).
**Owner:** John (GA4 Admin).
**Companion:** `docs/eng1-ga4-custom-dimensions.md` — the prior runbook whose
`entity_type` / `entity_id` dimensions this reuses.

## Why this exists

OPE-66 ships four server-side (Measurement Protocol, `_server`-suffix,
ad-block-proof) claim-funnel events:

| Event                                 | Fires from                                                 | Params                               |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `claim_view_server`                   | register page beacon → mirror in `/api/analytics/track`    | `entity_type`, `entity_id`           |
| `claim_account_created_server`        | `/api/auth/register` (claim signup)                        | `entity_type`, `entity_id`           |
| `claim_verification_attempted_server` | `/api/auth/register` (email-match) + `/api/claim/evidence` | `entity_type`, `entity_id`, `method` |
| `claim_completed_server`              | `/verify-email/[token]` (rung-1 auto-approve)              | `entity_type`, `entity_id`, `method` |

The event contract lives in `src/lib/analytics/claim-funnel.ts`. Every event
also carries `transport: "server"` for explicit filtering in explorations.

**GA4 does not surface custom event params in standard reports (or the Data API
/ `get_ga4_event_detail` MCP tool) until they are registered as custom
dimensions.** Without the Admin step below, the event _counts_ are captured
(visible in Realtime / DebugView) but the per-`method` / per-entity breakdown is
invisible in Engagement reports and explorations.

## Pre-flight (do this so the 24h propagation window opens early)

### A) Reuse existing dimensions — no action if already registered

`entity_type` and `entity_id` were registered for ENG1 (favorites / share /
print). If they already exist as **event-scoped** custom dimensions, the four
claim events inherit them automatically — nothing to do. Confirm at
GA4 Admin → Custom definitions → Custom dimensions.

### B) Register the ONE new dimension — `method`

1. Open <https://analytics.google.com/> → select the property.
2. Admin → Custom definitions → Custom dimensions → **Create custom dimension**.
   - **Dimension name:** `method`
   - **Scope:** Event
   - **Event parameter:** `method`
3. Save. Allow ~24h for values to populate historical reports (Realtime shows it
   immediately).

Value set (closed union in `claim-funnel.ts`): `EMAIL_MATCH`, `DOMAIN_MATCH`,
`MAGIC_LINK`, `EVIDENCE`, `ADMIN`. Only `EMAIL_MATCH` and `EVIDENCE` fire today;
`DOMAIN_MATCH` / `MAGIC_LINK` arrive with the OPE-64 claim wizard.

### C) Configure the MP secret (makes the events non-inert)

The server-side sender is **inert until configured** — it no-ops unless both
env vars are set on the main-app Worker:

- `GA4_MEASUREMENT_ID` — the GA4 data stream Measurement ID (`G-…`).
- `GA4_MP_API_SECRET` — Admin → Data Streams → (stream) → Measurement Protocol
  API secrets → **Create**.

These are the same two vars ENG1.8 uses; if the outbound-click server mirror is
already live, no action is needed here.

## Verify (acceptance)

1. In GA4 **Realtime** (or DebugView), run a test claim end-to-end:
   - Land on `/register?role=VENDOR&claim=<a-real-vendor-slug>` → `claim_view_server`.
   - Complete signup → `claim_account_created_server` (+ `claim_verification_attempted_server`
     with `method=EMAIL_MATCH` when the account email matches the listing contact).
   - Click the email verification link → `claim_completed_server` (`method=EMAIL_MATCH`).
   - Or, on a no-match listing, file the "verify another way" evidence →
     `claim_verification_attempted_server` (`method=EVIDENCE`).
2. Confirm the four events appear with `entity_type` / `entity_id` / `method`
   populated. **Standard reports lag and hide low volume — verify in Realtime.**
3. Build a funnel exploration: `claim_view_server` → `claim_account_created_server`
   → `claim_verification_attempted_server` → `claim_completed_server`.

## Notes

- Use a **real** vendor/promoter slug for the smoke test, but note that
  `test-vendor` / `test-vendor-co` / `test-promoter` and any slug containing
  `smoke-test` are **filtered out** at the source (`isSmokeTestEntityId` in
  `claim-funnel.ts`) — add real smoke-test slugs there if the fixture changes.
- These `_server` events are **distinct names** from the legacy ENG1.5 client
  funnel (`claim_started` / `claim_submitted` / `claim_approved`), so they do
  not double-count. Mark the `_server` variants as key events if the claim
  funnel becomes a tracked conversion.
