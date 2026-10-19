# `/go/` — newsletter click redirect (OPE-1496)

A first-party log-then-302 for newsletter links that leave the site (Apply
buttons, ticket links). The destination is read from the event record; no
request parameter can set it.

## Link shape

```
https://meetmeatthefair.com/go/<kind>/<event-slug>?c=<campaign>&s=<source>&m=<medium>&l=<label>
```

| part   | values                                                    |
| ------ | --------------------------------------------------------- |
| `kind` | `apply` · `tickets`                                       |
| `c`    | campaign, e.g. `vendor-digest-2026-10-26` (kept as given) |
| `s`    | source, e.g. `newsletter` (lower-cased)                   |
| `m`    | medium, e.g. `email` (lower-cased)                        |
| `l`    | optional link position / label, e.g. `card-3`             |

Every value is trimmed and capped at 100 characters. With no `s`/`m` the row
reads `(direct)` / `(none)`, the same rule as the on-site beacon.

**Destination precedence**

- `apply`: `application_url` → `source_url` → promoter `website` → `/events/<slug>`
- `tickets`: `ticket_url` → `source_url` → `/events/<slug>`

A stored value that is not `http(s)` is skipped. A retired slug follows
`event_slug_history`. An unknown or non-public event goes to `/events`
(`resolved: false`).

The response is always `302`, `Cache-Control: no-store`,
`X-Robots-Tag: noindex`, and `/go/` is disallowed in `robots.txt`.

## What gets written

One `analytics_events` row per hit, `source = 'redirect'`, written in
`waitUntil` (a failed write never blocks the redirect).

| who                   | `event_name`                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| a person              | `outbound_application_click` / `outbound_ticket_click`                 |
| a scanner or prefetch | `outbound_application_click_scanner` / `outbound_ticket_click_scanner` |

Scanner hits get their **own name** on purpose. Every conversion report counts
the two shared names, and mail scanners (Gmail's proxy, Barracuda, Proofpoint,
Mimecast) fetch every link on send. Under the shared names they would count as
conversions everywhere. They are kept, not dropped, so the filter can be
checked. `ua_class` (`human` / `scanner`) and `ua_reason` (`head`, `prefetch`,
`empty-ua`, `ua:<token>`) are on every row.

`properties`: `eventSlug, destinationUrl, resolvedFrom, resolved, campaign,
trafficSource, trafficMedium, linkLabel, ua_class, ua_reason?, device, os`.

A person's resolved click is also mirrored to GA4 server-side as
`outbound_*_click_server`, the same as the on-site beacon.

**Known limits.** Microsoft Safe Links often sends a stock browser user agent,
so it can read as `human`. The ticket's "click within ~2 s of the send" flag is
not implemented: nothing maps a campaign string to a send time today.

## On-site clicks carry the campaign too

The on-site beacon (`trackOutbound*Click`) now stores `campaign` from the
landing URL's `utm_campaign`, beside `trafficSource` / `trafficMedium`. So a
`?utm_campaign=weekend-digest-2026-10-23` landing and a
`/go/…?c=weekend-digest-2026-10-23` click report under the same key.

## Counting clicks per campaign (D1, read-only)

People only, both routes (on-site beacon + redirect):

```sql
SELECT json_extract(properties,'$.campaign')  AS campaign,
       json_extract(properties,'$.eventSlug') AS event,
       event_name,
       source,
       COUNT(*) AS clicks
FROM analytics_events
WHERE event_name IN ('outbound_application_click','outbound_ticket_click')
  AND timestamp > unixepoch('now','-30 days')
  AND json_valid(properties)
  AND json_extract(properties,'$.campaign') IS NOT NULL
GROUP BY 1,2,3,4
ORDER BY clicks DESC;
```

Check the scanner filter (what was set aside, and why):

```sql
SELECT json_extract(properties,'$.campaign')  AS campaign,
       json_extract(properties,'$.ua_reason') AS reason,
       COUNT(*) AS hits
FROM analytics_events
WHERE event_name IN ('outbound_application_click_scanner','outbound_ticket_click_scanner')
  AND timestamp > unixepoch('now','-30 days')
GROUP BY 1,2
ORDER BY hits DESC;
```

`timestamp` is in **seconds** in raw SQL.

## Heartbeat

The probe `go-click-redirect` (`src/lib/heartbeat.ts`, 336h) ships **dormant**
(`drizzle/0380`, `enabled_at` NULL). Arm it on the day the first digest sends
with `/go/` links:

```sql
UPDATE heartbeat_probes SET enabled_at = unixepoch(), updated_at = unixepoch()
WHERE probe_name = 'go-click-redirect';
```
