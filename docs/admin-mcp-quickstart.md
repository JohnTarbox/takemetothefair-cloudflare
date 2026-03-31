# Admin Quickstart: Connect Claude to Meet Me at the Fair

This guide walks you through verifying your admin account, generating an API token, and connecting Claude so it can manage events, review vendor applications, and handle all platform administration on your behalf.

---

## Part 1: Verify Your Admin Account

Admin accounts are set up by the platform owner. To confirm your account has admin access:

1. Log in at [meetmeatthefair.com](https://meetmeatthefair.com).
2. Go to [meetmeatthefair.com/dashboard/settings](https://meetmeatthefair.com/dashboard/settings).
3. Confirm your role shows **Admin** on the settings page.

If your role shows User, Vendor, or Promoter, contact the platform owner to have it upgraded.

---

## Part 2: Generate an API Token

Claude needs an API token to act on your behalf. Tokens are created from your account settings.

1. Go to [meetmeatthefair.com/dashboard/settings](https://meetmeatthefair.com/dashboard/settings).
2. Scroll down to the **API Tokens** section.
3. Enter a name for the token (e.g., `Claude`) and click **Generate**.
4. **Copy the token immediately.** It starts with `mmatf_` and will only be displayed once. If you lose it, you'll need to revoke it and create a new one.

You can have up to 5 active tokens. To revoke a token, click the trash icon next to it in the token list.

---

## Part 3: Connect Claude

### In Claude Desktop (Cowork)

1. Open **Claude Desktop** and go to **Settings > Connectors** (or **Cowork > Custom Connectors**).
2. Click **Add Connector**.
3. Enter:
   - **Name:** Meet Me at the Fair
   - **URL:** `https://meetmeatthefair-mcp.john-tarbox-account.workers.dev/mcp`
   - **Authentication:** Bearer Token
   - **Token:** Paste the `mmatf_...` token you copied earlier
4. Click **Save** or **Connect**.

Claude will discover the available tools automatically. You should see it confirm the connection with tools like `list_all_events`, `update_event_status`, `search_events`, etc.

### Verify the Connection

Ask Claude something like:

> "Show me all pending events."

Claude should call the `list_all_events` tool with a status filter and return events awaiting approval.

Then try an admin action:

> "List all vendor applications for the Bangor State Fair."

Claude should call `list_event_vendors_admin` and show the full list of vendors with their application and payment statuses.

---

## Part 4: What You Can Ask Claude to Do

As an admin, Claude has access to **all 19 tools** on the platform — the full superset of public, user, vendor, promoter, and admin capabilities.

### Event Administration (Admin Only)

These tools are exclusive to admin accounts:

| What to ask | What happens |
|-------------|-------------|
| "Show me all pending events" | Browses all events, optionally filtered by status (DRAFT, PENDING, TENTATIVE, APPROVED, REJECTED, CANCELLED) |
| "Search all events with 'fair' in the name" | Searches events by name across all statuses |
| "Approve the Augusta Boat Show" | Changes an event's status (e.g., PENDING → APPROVED) |
| "Reject this event and set it to cancelled" | Updates an event to any valid status |
| "Show all vendor applications for the Fryeburg Fair" | Lists every vendor application with full status and payment details |
| "Filter to just the applied vendors" | Filters vendor applications by status (APPLIED, APPROVED, CONFIRMED, etc.) |
| "Approve this vendor's application" | Changes a vendor's application status with transition validation |
| "Mark this vendor's payment as paid" | Updates payment status (NOT_REQUIRED, PENDING, PAID, REFUNDED, OVERDUE) |

**Admin tools:**
- `list_all_events` — Browse/search all events regardless of promoter ownership
- `update_event_status` — Approve, reject, or change any event's status
- `list_event_vendors_admin` — List all vendors for any event with full status details
- `update_vendor_status` — Change a vendor's application status or payment status

### Browsing (Public Tools)

| What to ask | What happens |
|-------------|-------------|
| "Find craft fairs in Vermont this summer" | Searches events by state and date range |
| "Tell me about the Augusta Boat Show" | Gets full event details — dates, venue, vendors, pricing |
| "What vendors are at the Bangor State Fair?" | Lists participating vendors for an event (approved/confirmed only) |
| "Search for food vendors" | Searches vendors by name or type |
| "Find venues in Portland" | Searches venues by city or state |

**Public tools:** `search_events`, `get_event_details`, `list_event_vendors`, `search_vendors`, `search_venues`

### Promoter Tools (Inherited)

As an admin, you also have promoter capabilities:

| What to ask | What happens |
|-------------|-------------|
| "Show events I'm promoting" | Lists your promoted events with application count summaries |
| "Show applications for my event" | Views vendor applications for events you promote |

**Promoter tools:** `list_my_events`, `get_event_applications`

### Vendor Tools (Inherited)

You also have full vendor capabilities:

| What to ask | What happens |
|-------------|-------------|
| "Show my vendor profile" | Displays your vendor business info |
| "Update my vendor description" | Updates fields on your vendor profile |
| "Show my vendor applications" | Lists all events you've applied to with statuses |
| "Apply to the Augusta Boat Show" | Submits a vendor application |
| "Withdraw my application from the Fryeburg Fair" | Withdraws an active application |
| "I heard about a new farmers market — can you add it?" | Creates a TENTATIVE event suggestion for review |

**Vendor tools:** `get_my_vendor_profile`, `update_vendor_profile`, `list_my_applications`, `apply_to_event`, `withdraw_application`, `suggest_event`

### Account (User Tools)

| What to ask | What happens |
|-------------|-------------|
| "Show my favorites" | Lists your favorited events, vendors, venues, and promoters |
| "Favorite the Bangor State Fair" | Toggles a favorite on or off |

**User tools:** `get_my_favorites`, `toggle_favorite`

---

## Troubleshooting

**"Unauthorized" errors from Claude:**
Your API token may be expired or revoked. Go to [/dashboard/settings](https://meetmeatthefair.com/dashboard/settings), revoke the old token, generate a new one, and update it in Claude's connector settings.

**Admin tools not showing up:**
Claude only sees admin tools when your account has the **Admin** role. If you're seeing a limited set of tools (just browsing and favorites), your account role may not be set to Admin. Check [/dashboard/settings](https://meetmeatthefair.com/dashboard/settings) to verify your role, or contact the platform owner.

**Claude can't find an event you know exists:**
The public `search_events` tool only returns events with **Approved** or **Tentative** status. Use `list_all_events` instead — it searches across all statuses including Draft, Pending, Rejected, and Cancelled.

**"Invalid transition" error when updating vendor status:**
Vendor application statuses follow a lifecycle with valid transitions. For example, you can't move a vendor directly from CONFIRMED to APPLIED. Claude will tell you which transitions are allowed from the current status.

**Claude shows fewer tools than expected:**
The MCP server registers tools based on your account role. Admin accounts get all 19 tools. If you see fewer, the API token may be associated with a non-admin account. Generate a new token from an account with the Admin role.
