# A9 — 21st-of-month bot traffic inflating GA4 (CF-native playbook)

**Status:** capture + exclusion runbook. No app code — these are Cloudflare
dashboard / GA4 actions an operator applies. Tied to Dev-Email-2026-06-26 A9.

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

## Phase 1 — Capture per-request identity (do BEFORE 7/21)

Goal: retain `ClientRequestUserAgent`, `ClientIP`, `ClientASN`,
`ClientRequestPath`, `ClientRequestHost`, `EdgeStartTimestamp`,
`ClientCountry` for `meetmeatthefair.com` across the 7/21 window.

**Token prerequisite:** the project's CF API token is D1-scoped only. Whichever
option below is used needs a token (or dashboard session) with **Account
Analytics / Logs** access — widen the token or perform the action in the
dashboard directly.

- **If on Enterprise → Logpush (best).** Dashboard → the zone → Analytics &
  Logs → **Logpush** → create a job, dataset **HTTP requests**, destination the
  existing **R2** bucket (`mmatf-vendor-assets`, or a new `mmatf-logs` bucket),
  fields as listed above. Logpush HTTP-requests is Enterprise-only.
- **If not Enterprise → the 7/22 Cowork watcher.** It is already scheduled to
  "re-pull GA4 + grab CF UA logs". Confirm it has a log source that exposes
  per-request UA/ASN (GraphQL Analytics `httpRequestsAdaptiveGroups` exposes
  `clientRequestHTTPHost`, `userAgent`, `clientASNDescription` aggregations on
  Pro/Biz — enough to surface the dominant UA/ASN on 7/21 even without full
  Logpush). If neither is available on the plan, the only remaining capture is
  the in-repo Worker-sampling fallback (deferred — see the A9 thread).

**On 7/21, identify** the dominant `(userAgent, ASN, IP-or-range)` tuple hitting
the fixed page block at identical counts. Record it below for Phase 2.

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
