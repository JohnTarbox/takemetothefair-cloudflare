# Admin Quickstart: Connect Claude to Meet Me at the Fair

This guide walks you through verifying your admin account and connecting Claude so it can manage events, review vendor applications, publish blog content, run analytics, and handle all platform administration on your behalf.

---

## Part 1: Verify Your Admin Account

Admin accounts are set up by the platform owner. To confirm your account has admin access:

1. Log in at [meetmeatthefair.com](https://meetmeatthefair.com).
2. Go to [meetmeatthefair.com/dashboard/settings](https://meetmeatthefair.com/dashboard/settings).
3. Confirm your role shows **Admin** on the settings page.

If your role shows User, Vendor, or Promoter, contact the platform owner to have it upgraded.

---

## Part 2: Connect Claude

### In Claude Desktop (Cowork)

1. Open **Claude Desktop** and go to **Settings > Connectors** (or **Cowork > Custom Connectors**).
2. Click **Add Connector**.
3. Enter:
   - **Name:** Meet Me at the Fair
   - **URL:** `https://mcp.meetmeatthefair.com/mcp`
4. Click **Save** or **Connect**.

Claude will open a browser window to sign you in:

5. Enter your **Meet Me at the Fair email and password** in the login form.
6. Click **Sign In & Authorize**.

The browser will close and Claude will confirm the connection.

### Verify the Connection

Ask Claude:

> "Run whoami"

You should see all eight admin toolsets listed:

- `public tools (9)`
- `user tools (2)`
- `vendor tools (7)` _(or `vendor tools (1 — suggest_event only)` if your admin account isn't also a vendor)_
- `promoter tools (3)`
- `admin tools (16)`
- `analytics tools (11)`
- `blog tools (6)`
- `content-links tools (4)`

That's **59 tools total** (58 role-based + `whoami`).

Then try an admin action:

> "List all vendor applications for the Bangor State Fair."

Claude should call `list_event_vendors_admin` and show the full list of vendors with their application and payment statuses.

---

## Part 3: What You Can Ask Claude to Do

As an admin, you get the full superset of public, user, vendor, promoter, admin, analytics, blog, and content-link capabilities.

### Event Administration

| What to ask                                              | Tool                                    |
| -------------------------------------------------------- | --------------------------------------- |
| "Show me all pending events"                             | `list_all_events`                       |
| "Find events missing a venue or image"                   | `list_all_events` with `missing_fields` |
| "Approve the Augusta Boat Show"                          | `update_event_status`                   |
| "Update the source URL for the Willows Highlands events" | `update_event`                          |
| "Re-scrape these 5 events to refresh their data"         | `rescrape_events`                       |

**Admin event tools:** `list_all_events`, `update_event_status`, `update_event`, `rescrape_events`

### Event Vendors

| What to ask                                                        | Tool                       |
| ------------------------------------------------------------------ | -------------------------- |
| "Show all vendor applications for the Fryeburg Fair"               | `list_event_vendors_admin` |
| "Add this vendor to the Bangor State Fair and mark them confirmed" | `create_vendor`            |
| "Approve this vendor's application and mark payment as paid"       | `update_vendor_status`     |
| "Update this vendor's profile (categories, description, website)"  | `update_vendor`            |

**Admin vendor tools:** `list_event_vendors_admin`, `create_vendor`, `update_vendor_status`, `update_vendor`

### Venues & Promoters

| What to ask                                             | Tool              |
| ------------------------------------------------------- | ----------------- |
| "Create a new venue at this address"                    | `create_venue`    |
| "Fix the coordinates on the Fryeburg Fairgrounds venue" | `update_venue`    |
| "Create a new promoter for Northern Lights Events"      | `create_promoter` |
| "Update this promoter's contact email"                  | `update_promoter` |

**Admin venue/promoter tools:** `create_venue`, `update_venue`, `create_promoter`, `update_promoter`

### Event Days (Multi-Day Events)

| What to ask                                          | Tool               |
| ---------------------------------------------------- | ------------------ |
| "Show the day-by-day schedule for the Fryeburg Fair" | `list_event_days`  |
| "Add a vendor-only setup day on Oct 2"               | `create_event_day` |
| "Change the hours on day 3"                          | `update_event_day` |
| "Remove that extra setup day"                        | `delete_event_day` |

**Event-day tools:** `list_event_days`, `create_event_day`, `update_event_day`, `delete_event_day`

### Analytics (11 tools)

All 11 analytics tools are admin-only and proxy to the main app's GA4 + Google Search Console integrations. Google credentials live on the main app — the MCP server never talks to Google directly.

**GA4 (traffic analytics):**

| What to ask                                                            | Tool                          |
| ---------------------------------------------------------------------- | ----------------------------- |
| "What's our site traffic look like for the last 28 days?"              | `get_analytics_overview`      |
| "Top 50 pages by traffic last month, sorted by engagement rate"        | `list_top_pages`              |
| "Give me detailed analytics for /events — include geography breakdown" | `get_page_analytics`          |
| "How is the Augusta Boat Show event page performing?"                  | `get_event_analytics`         |
| "Break down api_error events by endpoint and status code"              | `get_ga4_event_detail`        |
| "What are users searching for on our site?"                            | `get_internal_search_queries` |

**Google Search Console (SEO analytics):**

| What to ask                                                        | Tool                     |
| ------------------------------------------------------------------ | ------------------------ |
| "Which queries brought people to /blog/maine-fall-fairs?"          | `get_search_queries`     |
| "Site-wide top queries for the /blog/ subtree, min 50 impressions" | `get_top_search_queries` |
| "Which pages rank for 'fairs in maine' — are we cannibalizing?"    | `get_query_pages`        |
| "Are all our sitemap URLs indexed?"                                | `get_sitemap_status`     |
| "Why isn't /blog/my-new-post indexed yet?"                         | `get_url_inspection`     |

Most analytics tools accept date-range presets (`last_7d`, `last_28d`, `last_90d`, `mtd`, `ytd`, `prev_7d`, etc.) or explicit `startDate`/`endDate` (ISO `YYYY-MM-DD`). Pass `refresh: true` to bypass caches.

### Blog (6 tools)

| What to ask                                             | Tool                      |
| ------------------------------------------------------- | ------------------------- |
| "Draft a blog post about the 2026 Maine fair season"    | `create_blog_post`        |
| "Show me all draft blog posts"                          | `list_blog_posts`         |
| "Get the full content of the 'fall-foliage-fairs' post" | `get_blog_post`           |
| "Update the intro paragraph on that post"               | `update_blog_post`        |
| "Publish the 'fall-foliage-fairs' post"                 | `update_blog_post_status` |
| "Delete the test post I made yesterday"                 | `delete_blog_post`        |

**Blog tools:** `create_blog_post`, `get_blog_post`, `list_blog_posts`, `update_blog_post`, `update_blog_post_status`, `delete_blog_post`

### Content-Link Coverage (4 tools)

Tracks which events, venues, vendors, and promoters are being linked to from blog posts — useful for editorial planning and SEO.

| What to ask                                                    | Tool                                  |
| -------------------------------------------------------------- | ------------------------------------- |
| "Which Maine events have never been mentioned in a blog post?" | `list_entities_without_blog_coverage` |
| "Which blog posts link to the Fryeburg Fair?"                  | `get_blog_coverage`                   |
| "What entities does this blog post link to?"                   | `get_blog_links_in_post`              |
| "Give me blog-coverage stats across all entity types"          | `get_blog_coverage_stats`             |

**Content-link tools:** `list_entities_without_blog_coverage`, `get_blog_coverage`, `get_blog_links_in_post`, `get_blog_coverage_stats`

### Browsing (Public Tools — 9)

| What to ask                                  | Tool                   |
| -------------------------------------------- | ---------------------- |
| "Find craft fairs in Vermont this summer"    | `search_events`        |
| "Tell me about the Augusta Boat Show"        | `get_event_details`    |
| "What vendors are at the Bangor State Fair?" | `list_event_vendors`   |
| "Search for food vendors"                    | `search_vendors`       |
| "Find venues in Portland"                    | `search_venues`        |
| "Details on this venue"                      | `get_venue_details`    |
| "Who runs this vendor profile?"              | `get_vendor_details`   |
| "Who is this promoter?"                      | `get_promoter_details` |
| "Find all promoters in Maine"                | `search_promoters`     |

### Promoter Tools (Inherited — 3)

| What to ask                                     | Tool                        |
| ----------------------------------------------- | --------------------------- |
| "Show events I'm promoting"                     | `list_my_events`            |
| "Show applications for my event"                | `get_event_applications`    |
| "Approve this vendor's application to my event" | `update_application_status` |

### Vendor Tools (Inherited — 7)

| What to ask                                            | Tool                    |
| ------------------------------------------------------ | ----------------------- |
| "Show my vendor profile"                               | `get_my_vendor_profile` |
| "Update my vendor description"                         | `update_vendor_profile` |
| "Show my vendor applications"                          | `list_my_applications`  |
| "Apply to the Augusta Boat Show"                       | `apply_to_event`        |
| "Withdraw my application from the Fryeburg Fair"       | `withdraw_application`  |
| "Do I have any date conflicts with these events?"      | `check_date_conflicts`  |
| "I heard about a new farmers market — can you add it?" | `suggest_event`         |

Vendors without a vendor profile on their account only get `suggest_event` from this group.

### Account (User Tools — 2)

| What to ask                      | Tool               |
| -------------------------------- | ------------------ |
| "Show my favorites"              | `get_my_favorites` |
| "Favorite the Bangor State Fair" | `toggle_favorite`  |

---

## Troubleshooting

**Login page doesn't appear when connecting:**
URL must be exactly `https://mcp.meetmeatthefair.com/mcp`. If Claude doesn't open a browser window, remove and re-add the connector.

**"Invalid email or password" on the login page:**
Use the same email and password you use to log in at [meetmeatthefair.com](https://meetmeatthefair.com). Social login (Google/Facebook) accounts don't have passwords — set one first at `/dashboard/settings` or contact the platform owner.

**Admin tools not showing up:**
Claude only sees admin tools when your account has the **Admin** role. Run `whoami` — if the role isn't `ADMIN`, contact the platform owner.

**New tools don't appear after a recent platform update:**
Some MCP clients cache the tool list. Fully **disconnect** the connector in Claude's Settings → Connectors and re-add it. Reconnecting without removing is not always enough.

**Claude can't find an event you know exists:**
The public `search_events` tool only returns events with **Approved** or **Tentative** status. Use `list_all_events` — it covers Draft, Pending, Rejected, and Cancelled too.

**"Invalid transition" error when updating vendor status:**
Vendor application statuses follow a lifecycle with valid transitions. You can't move a vendor directly from CONFIRMED to APPLIED, for example. Claude will tell you which transitions are allowed from the current status.

**Analytics tool returns "MAIN_APP_URL and INTERNAL_API_KEY must be configured":**
The analytics tools proxy to the main Pages app. If either secret is missing in the MCP worker environment, analytics is unreachable. This is a deploy-time configuration issue — contact the platform owner.

**Analytics tool returns empty rows / blank parameter values:**
GA4 custom event parameters (e.g. `search_term`, `error_message`, `endpoint`) must be registered as custom dimensions in GA4 Admin → Custom Definitions before they populate. Unregistered params return empty even if the events fire.

**Connection stopped working:**
OAuth tokens expire periodically. Remove the connector in Claude's settings and add it again — you'll be prompted to sign in again.

**Prefer a static bearer token over OAuth:**
Create an MCP API token at [`/dashboard/settings`](https://meetmeatthefair.com/dashboard/settings) (API Tokens section). It'll be prefixed `mmatf_`. Use that as a Bearer token against `https://mcp.meetmeatthefair.com/mcp` — skips the OAuth flow entirely. Useful for CLI scripts.
