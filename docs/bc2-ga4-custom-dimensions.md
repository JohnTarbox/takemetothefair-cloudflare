# BC2 — GA4 custom dimensions setup (operator runbook)

**Filed:** 2026-06-08 alongside Dev-Email-2026-06-08 §D (and the prior
Blog Outbound Click Attribution spec already in the dev folder).
**Owner:** John (GA4 Admin).

## Why this exists

PR #408 ships the client-side instrumentation: a delegated click handler
in `MarkdownContent` fires the GA4 event `blog_outbound_click` with three
custom params (`source_slug`, `target_type`, `target_slug`) whenever a
reader clicks an internal `/events|/vendors|/venues|/blog` link in a
blog post body.

But: **GA4 does not surface custom event params in standard reports
(or via the GA4 Data API / `get_ga4_event_detail` MCP tool) until they
are registered as custom dimensions**. Without this one-time Admin step,
the event count is captured but the per-source/per-target breakdown is
invisible.

The first-party beacon side is independent of this: every fired event
also POSTs to `/api/analytics/track`, which writes to D1 immediately.
GA4 registration is needed for the GA4-side rollup (the Blog Performance
dashboard's bottom funnel stage).

## Steps

1. Open <https://analytics.google.com/> → select the
   `meetmeatthefair.com` property.
2. Admin (cog at lower-left) → **Custom Definitions** (under Data
   Display).
3. **Custom dimensions** tab → **Create custom dimensions**.

Create **three** custom dimensions, all event-scoped, names matching the
client payload exactly:

| Dimension name   | Scope | Event parameter | Description                              |
| ---------------- | ----- | --------------- | ---------------------------------------- |
| Blog source slug | Event | `source_slug`   | The blog post the click originated from  |
| Blog target type | Event | `target_type`   | `EVENT` \| `VENDOR` \| `VENUE` \| `BLOG` |
| Blog target slug | Event | `target_slug`   | Destination listing slug                 |

The dimension names are display-only — they can be anything; what
matters is the **Event parameter** name, which must match the param
key in the client payload exactly (case-sensitive).

## After registration

- Allow **~24 hours** for processing before the dimensions become
  queryable. New events fired in the meantime ARE recorded with the
  params — they just don't appear in reports / the Data API until the
  property finishes ingesting.
- Verify in GA4 → Reports → Engagement → Events → click
  `blog_outbound_click` → confirm the three custom dimensions appear in
  the drill-down list.
- The MCP tool `get_ga4_event_detail` (when called with
  `event_name=blog_outbound_click`) will then return param breakdowns
  once the 24-hour processing window elapses.

## Sanity check (immediate)

In **Realtime → Events** within a few minutes of deploy:

1. Open <https://meetmeatthefair.com/blog/<any-post-with-internal-link>>
2. Click an internal `/events/...` link in the body.
3. Switch to Realtime → Events. `blog_outbound_click` should appear with
   `event_count: 1`.

If the event doesn't appear in Realtime, GA4 is not receiving the
beacon at all — investigate `window.gtag` availability + the
`NEXT_PUBLIC_GA_MEASUREMENT_ID` envvar before troubleshooting the
custom dimensions.

## Related

- `src/lib/analytics.ts:trackBlogOutboundClick` — the firing helper.
- `src/components/blog/markdown-content.tsx:useEffect` — the delegated
  click handler.
- `src/app/api/analytics/track/route.ts:ALLOWED_EVENT_NAMES` — the
  first-party beacon allowlist (D1-side capture, independent of GA4).
- `[[project_ga4_server_reporting]]` — the server-side jose JWT path
  the MCP `get_ga4_event_detail` tool uses.
- `Dev-Email-2026-06-05-Blog-Outbound-Click-Attribution.md` — the
  original spec doc.
