# Vendor Quickstart: Connect Claude to Meet Me at the Fair

This guide walks you through creating a vendor account on Meet Me at the Fair, verifying everything works, and connecting your account to Claude so it can search events, manage applications, and update your profile on your behalf.

---

## Part 1: Create Your Vendor Account

### Step 1: Sign Up

1. Go to [meetmeatthefair.com/register](https://meetmeatthefair.com/register).
2. Under **I want to join as**, select **Vendor**.
3. Fill in:
   - **Business Name** (shown publicly on the site)
   - **Full Name** (your personal name)
   - **Email** and **Password**
4. Complete the CAPTCHA and click **Create Account**.

> You can also sign up with Google or Facebook. If you use a social login, you'll be registered as a general user first — contact support to have your role upgraded to Vendor.

### Step 2: Complete Your Profile

After logging in, you'll land on your **Dashboard**. Click the **Vendor Portal** card, or navigate directly to [meetmeatthefair.com/vendor/profile](https://meetmeatthefair.com/vendor/profile).

Fill in as much as you can:

| Section              | Key Fields                                                                             |
| -------------------- | -------------------------------------------------------------------------------------- |
| **Business Info**    | Description, Vendor Type (e.g. Food, Crafts, Agriculture), Products, Website, Logo URL |
| **Contact Info**     | Contact name, email, phone                                                             |
| **Address**          | Street, City, State, ZIP — use the Google Place search to auto-fill                    |
| **Business Details** | Year established, payment methods, license/insurance info                              |

Click **Save Changes** when you're done.

### Step 3: Verify Your Account Is Working

To confirm everything is set up correctly, try these quick checks:

**Browse events and apply to one:**

1. Go to [meetmeatthefair.com/events](https://meetmeatthefair.com/events).
2. Open an event that interests you.
3. Look for the **Apply as Vendor** button and submit an application.
4. Go back to [meetmeatthefair.com/vendor/applications](https://meetmeatthefair.com/vendor/applications) — you should see your application listed with status **Applied** (or **Confirmed** if you're a trusted vendor with self-confirm enabled).

**Check the sidebar navigation works:**

From any `/vendor/*` page, the sidebar should show:

- My Profile
- Applications
- Suggest Event
- My Submissions
- Settings

If you can see all of these and your profile loads with the business name you entered during registration, your account is working correctly.

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

5. Enter your **Meet Me at the Fair email and password**.
6. Click **Sign In & Authorize**.

The browser will close and Claude will confirm the connection with tools like `search_events`, `apply_to_event`, `list_my_applications`, etc.

### Verify the Connection

Ask Claude something like:

> "What events are happening in Maine in April?"

Claude should call the `search_events` tool and return a list of upcoming events with dates, locations, and categories.

Then try an authenticated action:

> "Show me my vendor applications."

Claude should call `list_my_applications` and show your current applications and their statuses.

---

## Part 3: What You Can Ask Claude to Do

Once connected, Claude has access to these tools through your account:

### Browsing (no login required)

| What to ask                                  | What happens                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| "Find craft fairs in Vermont this summer"    | Searches events by state and date range                  |
| "Tell me about the Augusta Boat Show"        | Gets full event details — dates, venue, vendors, pricing |
| "What vendors are at the Bangor State Fair?" | Lists participating vendors for an event                 |
| "Search for food vendors"                    | Searches vendors by type                                 |
| "Find venues in Portland"                    | Searches venues by city                                  |

### Managing Your Account

| What to ask                                          | What happens                                     |
| ---------------------------------------------------- | ------------------------------------------------ |
| "Show my favorites"                                  | Lists your favorited events, vendors, and venues |
| "Favorite the Bangor State Fair"                     | Toggles a favorite on or off                     |
| "Show my vendor profile"                             | Displays your business info                      |
| "Update my description to ..."                       | Updates fields on your vendor profile            |
| "Update my products to include pottery and ceramics" | Updates your products list                       |

### Applications

| What to ask                                       | What happens                                               |
| ------------------------------------------------- | ---------------------------------------------------------- |
| "Show my applications"                            | Lists all events you've applied to with statuses           |
| "Show only my confirmed applications"             | Filters by status                                          |
| "Apply me to the Augusta Boat Show"               | Submits a vendor application to that event                 |
| "Withdraw my application from the Fryeburg Fair"  | Withdraws an active application                            |
| "Do I have any date conflicts with these events?" | Checks overlap between events and your active applications |

### Suggesting Events

| What to ask                                                                          | What happens                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| "I heard about a new farmers market in Brunswick starting in June — can you add it?" | Creates a TENTATIVE event suggestion that admins will review |

---

## Troubleshooting

**Login page doesn't appear when connecting:**
Make sure the connector URL is exactly `https://mcp.meetmeatthefair.com/mcp`. If Claude doesn't open a browser window, try removing and re-adding the connector.

**"Invalid email or password" on the login page:**
Use the same email and password you use to log in at [meetmeatthefair.com](https://meetmeatthefair.com). If you signed up with Google or Facebook, you don't have a password set — contact support or set a password through the site first.

**Claude can't find an event you know exists:**
The search tool only returns events with **Approved** or **Tentative** status. Draft, Pending, or Cancelled events don't appear in search results.

**"Vendor profile not found" error:**
This means your user account exists but doesn't have a vendor profile linked. Go to [/vendor/profile](https://meetmeatthefair.com/vendor/profile) to confirm your profile exists. If you signed up via social login as a regular user, your role may need to be upgraded.

**"This event does not allow commercial vendors":**
Some events restrict participation to non-commercial vendors. If your profile is marked as commercial, you won't be able to apply to those events.

**Claude shows fewer tools than expected:**
The tools Claude sees depend on your account role. Vendor tools only appear for users with the Vendor role. Ask Claude to run the `whoami` tool to check. If you're logged in as a regular User, you'll only see the public browsing tools and favorites.

**Connection stopped working:**
OAuth tokens expire periodically. Remove the connector in Claude's settings and add it again — you'll be prompted to sign in again.
