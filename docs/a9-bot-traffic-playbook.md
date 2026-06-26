# A9 — 21st-of-month bot traffic inflating GA4 (CF-native playbook)

**Status:** Phase 1 (capture) is SHIPPED as in-repo edge sampling (zone is
Free-plan → Logpush unavailable). Phase 2 (exclusion) stays operator-applied
Cloudflare/GA4 actions, keyed on what Phase 1 captures. Tied to
Dev-Email-2026-06-26 A9.

## The signature (from the 2026-05-21 + 2026-06-21 spikes)

Two daily-active-user spikes (1,466 and 1,419 users) share a bot fingerprint:

1. ~90% `(direct)/(none)` source/medium
2. `first_visit ≈ session_start ≈ users` (≈100% new, one session each)
3. A fixed block of unrelated pages hit at **identical** counts (5/21: 8 pages × 48; 6/21: a block × 83) — a crawler walking a fixed URL list
4. Low engagement for the volume
5. **Recurs on the 21st of the month** ⇒ a scheduled/recurring crawler

It reaches **GA4** (shows in active-users) but fires **no** first-party
`analytics_events` beacon, and GA4 doesn't expose raw UA — so it can't be
identified from data we already hold. Next occurrence: **~2026-07-21**.

## Why two phases

You cannot exclude what you can't name. The bot's stable identifiers
(User-Agent, ASN, IP/range) only exist in **edge request logs**, which we don't
retain today. So: **Phase 1 = capture identity on 7/21**, then **Phase 2 =
exclude by that identity**.

---

## Verified environment (2026-06-26)

- **Account:** jtarboxme@gmail.com / "John Tarbox - Account" (`e6011e48b7014ef83c77e3c767dac6cf`).
- **Zone:** `meetmeatthefair.com` (`56813c11d72ec3ddf2a9585bbc7f6956`), **plan = FREE.**
- **Implication:** **Logpush (HTTP-requests dataset) is Enterprise-only → NOT available.** The project API token (`80cdaef3…`) also lacks `zone.analytics.read`. So the clean CF-native raw-UA capture is off the table regardless of token scope — which is why capture is done **in-repo**.

## Phase 1 — Capture per-request identity (SHIPPED, in-repo edge sampling)

`src/middleware.ts` samples **5%** of public page requests (the matcher's
detail-page set: events/vendors/venues/blog/promoters) and writes UA + IP + ASN
(`getCloudflareContext().cf.asn`) + path to the `request_samples` table
(`drizzle/0130`), fire-and-forget via `ctx.waitUntil` (never blocks the
response). Rows self-prune to ~60 days. See `src/lib/request-sampling.ts`. No
plan upgrade or token change needed — it uses the existing D1 binding.

> Coverage note: sampling rides the existing middleware matcher (detail pages),
> not listing/home pages. A content crawler walking "unrelated pages" hits
> detail URLs, so this should catch it; if the 7/21 read comes back empty,
> broaden the matcher to include `/` and the listing routes and redeploy.

**On / just after 7/21, read the fingerprint** (admin session or `X-Internal-Key`):

```
GET /api/admin/request-samples?since=2026-07-21&until=2026-07-22
```

Returns `fingerprints` grouped by `(asn, as_organization, user_agent)` ordered by
count, plus `top_paths`. The bot = the high-count tuple hitting few distinct
paths (counts are of the 5% sample → ×~20 for population). Record it for Phase 2:

```
# Fill in after 7/21:
BOT_UA        = "________"
BOT_ASN       = ____        # e.g. 14618 (AWS), 396982 (GCP), 16509, ...
BOT_IP_RANGE  = "________"  # if stable
```

---

## Phase 2 — Exclude (apply once identity is known)

### 2a. WAF Custom Rule (stops it at the edge → it never reaches GA4)

Dashboard → the `meetmeatthefair.com` zone → **Security → WAF → Custom rules →
Create rule**. Expression (narrow with whatever combination is distinctive —
prefer UA, add ASN only if the UA alone is ambiguous):

```
(http.host eq "meetmeatthefair.com") and (
  http.user_agent contains "<BOT_UA>"
  or ip.geoip.asnum eq <BOT_ASN>
)
```

**Action: Managed Challenge** (preferred). The crawler runs no JS / can't solve
it, so it's stopped while humans pass; this also means it no longer loads pages,
so the GA4 spike disappears at the source. Use **Block** only if the UA/ASN is
unambiguously non-human (blocking by ASN alone can catch legit cloud-proxied
users — keep ASN as a secondary signal, not the sole match).

> Edge exclusion is the load-bearing fix: because the bot reaches GA4 by loading
> the page, stopping the load removes it from active-users without any GA4-side
> work.

### 2b. GA4 belt-and-suspenders

- **Data stream → Configure tag settings → Show more → "Exclude all events from
  known bots and spiders"** — confirm it's **ON** (it is custom, so may not be on
  IAB's list, but keep it enabled).
- If `BOT_IP_RANGE` is stable: **Admin → Data Streams → the stream → Configure
  tag settings → Define internal traffic** → add a rule matching the IP range,
  then **Admin → Data Settings → Data Filters** → create/activate an
  **Internal Traffic** filter set to **Exclude** (start in _Testing_, then
  _Active_). Note: GA4 has no native User-Agent filter, which is exactly why the
  edge WAF rule (2a) is the primary control.

---

## Verify (after 2026-08-21)

1. **WAF → Events** shows the rule firing on the 8/21 window (challenge/block count ≈ the prior spike volume).
2. The GA4 **daily active users** chart shows **no** phantom 21st-of-month spike.
3. KPIs that read GA4 active-users return to baseline on the 21st.

If the spike persists, the bot rotated UA/ASN — re-capture (Phase 1) and widen
the rule.
