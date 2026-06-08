/**
 * Public vendor how-to guide. Content is markdown, rendered via the same
 * MarkdownContent component the blog uses, so authors can edit the text
 * without touching JSX. Cloudflare Pages edge runtime has no `fs`, so
 * we can't read docs/vendor-guide.md at request time — instead the
 * content lives inline below and the docs/ file stays as the
 * developer-facing reference. Keep the two in sync when content
 * changes; they're not large. The MD-source-of-truth lives here so
 * what ships to the public site is what the page literal holds.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { MarkdownContent } from "@/components/blog/markdown-content";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { WebPageSchema } from "@/components/seo/WebPageSchema";

export const runtime = "edge";
export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Vendor Guide | Meet Me at the Fair",
  description:
    "How to sign up, verify your email, claim or create your listing, edit your profile, and apply to events on Meet Me at the Fair.",
  alternates: { canonical: "https://meetmeatthefair.com/vendor-guide" },
  openGraph: {
    title: "Vendor Guide | Meet Me at the Fair",
    description:
      "How to sign up, verify your email, claim or create your listing, edit your profile, and apply to events on Meet Me at the Fair.",
    url: "https://meetmeatthefair.com/vendor-guide",
    siteName: "Meet Me at the Fair",
    type: "article",
  },
};

// Content mirrors docs/vendor-guide.md. When updating, edit both so
// the dev-facing markdown stays an accurate reference of what ships.
const GUIDE_MARKDOWN = `## 1. Get started — two paths

Before you sign up, search the site for your business name at
[/vendors](/vendors). One of two things is true:

### Path A — Your business is already listed

If you see a page that looks like yours (e.g., the listing was created
by us during event coverage or imported from a fair's vendor roster),
**don't create a duplicate**. Use the **"Claim this listing"** button
on your vendor page. It opens a signup form with your business name
pre-filled. Sign up with the email you want your account on, then
verify it (see Section 2 below).

What happens next depends on which email is already on file for the
listing. There are three cases.

#### Case 1 — Fast path: your email is already the listing's contact email

If the email you signed up with **matches the contact email already on
the listing**, claim is **one click** — no second email needed. Once
you've verified your address (Section 2), go to your vendor page or
your dashboard's "Claim my listing" widget and the button reads
**"Claim this listing now"**. Click it. The "Claimed" badge appears on
your public page on the next load.

This is the fast path because the email-verification step you just did
also proves you control the email that's listed as the business
contact — both proofs collapse into one.

#### Case 2 — Standard path: a different email is on file as the business contact

If the listing has a contact email on file that's different from your
signup email (a personal account email vs. an info@yourbusiness.com,
for example), proving ownership requires access to the business's
listed mailbox:

1. From your dashboard or vendor profile, click **"Send me a
   confirmation email"** in the "Claim my listing" widget.
2. The confirmation email is sent to the **business's contact email on
   file** — not your signup email. The page tells you which mailbox
   (masked): "We sent a confirmation to in***@yourbusiness.com".
3. Open that mailbox. Click the link in the email.
4. Your listing now shows a "Claimed" badge.

If you don't have access to that mailbox, the claim won't complete on
this path — see Case 3.

#### Case 3 — No contact email on file: ask support

If the listing has no contact email on file (common for older listings
imported from public fair rosters), neither of the above paths can
verify business ownership. The "Send me a confirmation email" button
returns a message like:

> This listing has no contact email on file, so we can't send a
> verification to verify business ownership. Please contact support —
> an admin can approve the claim manually.

Email us via the contact link in the footer. Include the listing URL
and any way we can confirm you represent the business (a business
domain email, registration documents, prior MMATF correspondence). An
admin will approve and grant you the listing manually.

### Path B — Your business isn't listed yet

Go to [/register](/register) and pick "Vendor" as the role. Provide:

- Business name
- Your email
- A password

After you submit, you'll get a verification email — click the link to
prove the address is yours. Your listing is created at
\`/vendors/{your-business-slug}\` immediately, but a few things wait on
verification (see below).

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

1. Sign in at [/login](/login).
2. Open **Your profile** from the top-right menu, or go directly to
   [/vendor/profile](/vendor/profile).
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
     Profile only). It's never displayed in the page HTML — it stays
     server-side.
   - **Address, city, state, ZIP** — for geographic search and
     location-based recommendations.
   - **Year established, payment methods, license/insurance info** —
     all optional, but they bump your completeness score, which
     influences how prominently you surface in vendor lists.
4. Click **Save**.

A "Profile completeness" indicator on the page shows you what's
missing. Higher completeness = better visibility on the site.

## 4. Apply to an event

1. Browse events at [/events](/events).
2. Open an event you're interested in.
3. Click **Apply** on the event page. Optionally add a note about
   your booth needs.
4. Your application appears on the [Applications](/vendor/applications)
   page with a status (\`APPLIED\`, \`WAITLISTED\`, \`APPROVED\`,
   \`CONFIRMED\`, etc.).
5. If two events you're applied to overlap on date, the page flags
   the conflict so you can withdraw from one.

Some events let approved vendors self-confirm — for those you'll go
straight from \`APPLIED\` to \`CONFIRMED\` once the promoter approves.

## 5. Suggest an event we don't have

If you spot a fair that should be on the site but isn't:

1. Go to [/vendor/suggest-event](/vendor/suggest-event).
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
self-service signup today — [contact us](/contact) if you want to
enable it for your business.

## 7. Troubleshooting

**The verification email never arrived.** Check spam first. If it's
not there, click "Resend verification" from your dashboard banner. If
the second one also doesn't arrive within 5 minutes, write to us at
[support](/contact) — there may be a deliverability issue with your
mailbox provider.

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

**Someone else "claimed" my business listing.** [Reach out to us](/contact).
The claim flow normally requires the claimer to have access to either
the email already on file as the business contact (Case 2 above) or —
if no contact email is on file — an admin's manual approval (Case 3).
That makes the most common forms of false-claim hard, but we can
investigate disputed claims case-by-case if something slipped through.

**I clicked "Claim this listing" and the page says it has no contact
email on file.** That's Case 3 above. The listing was imported from a
public fair roster without an associated business mailbox, so neither
of the automated flows can verify ownership. [Email support](/contact) —
an admin can approve manually after out-of-band verification.

**My listing shows "Not Claimed."** That means no one has signed up
and confirmed ownership of it yet. Use the "Claim this listing" button
on your vendor page to start that flow (Path A above).
`;

export default function VendorGuidePage() {
  return (
    <>
      <WebPageSchema
        url="https://meetmeatthefair.com/vendor-guide"
        name="Vendor Guide | Meet Me at the Fair"
        description="How to sign up, verify your email, claim or create your listing, edit your profile, and apply to events on Meet Me at the Fair."
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "For Vendors", url: "https://meetmeatthefair.com/for-vendors" },
          { name: "Vendor Guide", url: "https://meetmeatthefair.com/vendor-guide" },
        ]}
      />

      <article className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12">
        <header className="mb-10">
          <p className="text-sm font-medium text-royal mb-2">For Vendors</p>
          <h1 className="text-4xl font-bold text-foreground mb-3">Vendor Guide</h1>
          <p className="text-lg text-muted-foreground">
            How to get on Meet Me at the Fair, get your listing set up, and keep it current.
          </p>
        </header>

        <div className="prose prose-gray max-w-none">
          <MarkdownContent content={GUIDE_MARKDOWN} />
        </div>

        <hr className="my-12 border-border" />

        <div className="flex flex-wrap gap-4 justify-center">
          <Link
            href="/register?role=VENDOR"
            className="inline-flex items-center px-5 py-2.5 bg-secondary text-secondary-foreground font-medium rounded-lg hover:bg-secondary/90 transition-colors"
          >
            Sign up as a vendor
          </Link>
          <Link
            href="/vendors"
            className="inline-flex items-center px-5 py-2.5 border border-border text-foreground font-medium rounded-lg hover:bg-muted transition-colors"
          >
            Browse vendor listings
          </Link>
        </div>
      </article>
    </>
  );
}
