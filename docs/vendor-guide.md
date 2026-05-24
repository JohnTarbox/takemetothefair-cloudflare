# Vendor Guide

How to get on Meet Me at the Fair, get your listing set up, and keep it
current. Written for vendors — if you're an admin or developer, you
want one of the other docs in this folder.

## 1. Get started — two paths

Before you sign up, search the site for your business name at
[meetmeatthefair.com/vendors](https://meetmeatthefair.com/vendors). One
of two things is true:

### Path A — Your business is already listed

If you see a page that looks like yours (e.g., the listing was created
by us during event coverage or imported from a fair's vendor roster),
**don't create a duplicate**. Use the **"Claim this listing"** button
on your vendor page. It opens a signup form with your business name
pre-filled.

After you submit:

1. You'll get a **verification email** at the address you signed up
   with. Click the link inside.
2. From your dashboard or the vendor profile page, you'll see a small
   "Claim my listing" widget. Click the button — that triggers a
   **second email** that confirms you actually control the address.
3. Click the link in the claim-confirmation email. Your listing now
   shows a "Claimed" badge.

You need to click **both** emails. The first proves the email belongs
to you; the second binds the listing to your account.

### Path B — Your business isn't listed yet

Go to [meetmeatthefair.com/register](https://meetmeatthefair.com/register)
and pick "Vendor" as the role. Provide:

- Business name
- Your email
- A password

After you submit, you'll get a verification email — click the link to
prove the address is yours. Your listing is created at
`meetmeatthefair.com/vendors/{your-business-slug}` immediately, but a
few things wait on verification (see below).

## 2. Verify your email — and why it matters

Until you click the verification link in the welcome email, your
account is in a "pending" state. The site shows an amber banner across
the top reminding you. **You can browse and view your profile, but you
can't:**

- Edit your vendor listing
- Apply to events
- Submit a new event for review
- (If you have an Enhanced Profile) receive messages from the public
  contact form

The verification link is good for **24 hours**. If it expires before
you click it, hit "Resend verification" from your dashboard banner and
a fresh one will arrive.

If you signed up with **Google or Facebook** (instead of email +
password), you're already verified — those providers vouch for your
address at sign-in time.

## 3. Edit your listing

Once verified:

1. Sign in at [meetmeatthefair.com/login](https://meetmeatthefair.com/login).
2. Open **Your profile** from the top-right menu, or go directly to
   [meetmeatthefair.com/vendor/profile](https://meetmeatthefair.com/vendor/profile).
3. Fill in or update:
   - **Business name** — also drives your public URL slug. Renaming
     here automatically 301-redirects the old URL to the new one so
     any inbound links keep working.
   - **Description** — what you sell or do, in your own words.
   - **Products / categories** — used for matching with events that
     are looking for vendors of your type.
   - **Logo URL** — a publicly-accessible image link. Enhanced Profile
     vendors get a larger logo treatment on the public page.
   - **Contact details** — name, email, phone. The email you list here
     is what we'd forward inbound contact-form messages to (Enhanced
     Profile only). Don't worry, it's never displayed in the page
     HTML — it stays server-side.
   - **Address, city, state, ZIP** — for geographic search and
     location-based recommendations.
   - **Year established, payment methods, license/insurance info** —
     all optional, but they bump your completeness score, which
     influences how prominently you surface in vendor lists.
4. Click **Save**.

A "Profile completeness" indicator on the page shows you what's
missing. Higher completeness = better visibility on the site.

## 4. Apply to an event

1. Browse events at
   [meetmeatthefair.com/events](https://meetmeatthefair.com/events).
2. Open an event you're interested in.
3. Click **Apply** on the event page. Optionally add a note about
   your booth needs.
4. Your application appears on the
   [Applications](https://meetmeatthefair.com/vendor/applications)
   page with a status (`APPLIED`, `WAITLISTED`, `APPROVED`,
   `CONFIRMED`, etc.).
5. If two events you're applied to overlap on date, the page flags
   the conflict so you can withdraw from one.

Some events let approved vendors self-confirm — for those you'll go
straight from `APPLIED` to `CONFIRMED` once the promoter approves.

## 5. Suggest an event we don't have

If you spot a fair that should be on the site but isn't:

1. Go to [meetmeatthefair.com/vendor/suggest-event](https://meetmeatthefair.com/vendor/suggest-event).
2. Paste the event's URL or fill in name + date + location.
3. Submit. We review submissions before publishing.

Once approved, you're auto-applied to the event if you want.

## 6. Enhanced Profile (paid tier)

A vendor with an active Enhanced Profile gets:

- Larger 200×200 logo at the top of the public page
- Photo gallery (up to 2 images) with a lightbox
- A green "Verified" badge next to the business name
- A contact form on the public page — visitors send you messages
  without your email ever appearing in the page source
- Placement in the rotating **Featured Vendors** section at the top of
  the main vendors page and category pages
- Optional branded URL (custom slug) — old URL still 301-redirects

Enhanced Profile is **$29/year**, admin-managed. There's no
self-service signup today — contact us if you want to enable it for
your business.

## 7. Troubleshooting

**The verification email never arrived.** Check spam first. If it's
not there, click "Resend verification" from your dashboard banner. If
the second one also doesn't arrive within 5 minutes, write to us at
support — there may be a deliverability issue with your mailbox
provider.

**I clicked the verification link and got "link expired."**
Verification links are valid for 24 hours. Click "Resend verification"
to get a fresh one.

**I tried to edit my profile and got "email_unverified."** Your
account hasn't verified yet — click the link in the verification
email, then retry.

**My business name in the form doesn't match my listing URL slug.**
The URL slug is derived from the business name (lowercased,
spaces-to-hyphens, special chars stripped). If you rename the business
in your profile, the URL changes too, and the old URL 301-redirects to
the new one — old links keep working.

**Someone else "claimed" my business listing.** Reach out to us. The
claim flow requires email-control proof of the email an account was
registered with, but it doesn't verify that the email belongs to the
business owner. We can investigate disputed claims case-by-case.

**My listing shows "Not Claimed."** That means no one has signed up
and confirmed ownership of it yet. Use the "Claim this listing" button
on your vendor page to start that flow (Path A above).
