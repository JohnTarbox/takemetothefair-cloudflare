/**
 * Help-article registry. The `/help` hub and `/help/[slug]` pages both read
 * from this list, so adding a help article is a single entry here.
 *
 * Bodies are Markdown rendered via the same <MarkdownContent> component the
 * blog uses (react-markdown + remark-gfm). Content lives inline because the
 * Cloudflare Workers/OpenNext runtime has no filesystem at request time.
 *
 * Code samples use 4-space-indented code blocks (CommonMark) rather than
 * triple-backtick fences — a backtick inside a JS template literal would
 * terminate the string, so indented blocks keep the source escape-free.
 * Inline code still uses escaped backticks (\`like this\`).
 *
 * NOTE (OPE-60): the FAQ + Glossary articles below are intentionally simple,
 * hand-authored Markdown placeholders. The D1-backed FAQ/glossary system
 * (structured entries, categories, FAQPage JSON-LD) is a later phase
 * (spec §3.3 / OPE-62); when it lands these two articles get replaced by the
 * data-driven surface.
 */
export interface HelpArticle {
  slug: string;
  title: string;
  /** One-line summary shown on the /help hub and used for meta description. */
  description: string;
  /** Grouping label on the hub (e.g. "Developers", "Vendors"). */
  category: string;
  /** Audience hint shown on the hub card. */
  audience: string;
  /** Markdown body. */
  body: string;
}

/**
 * The canonical, ordered list of hub section labels. The index page renders
 * sections in this order; the test suite asserts every article's `category`
 * is one of these seven.
 */
export const HELP_SECTIONS = [
  "For Fairgoers",
  "For Vendors & Exhibitors",
  "For Promoters",
  "For Venues",
  "Developers",
  "FAQ",
  "Glossary",
] as const;

export type HelpSection = (typeof HELP_SECTIONS)[number];

const SYNDICATION_DEVELOPER_GUIDE = `Keep your own copy of our event data **live** instead of letting it go stale.
If your site mirrors events from Meet Me at the Fair, this system pushes you a
**signed webhook within minutes** every time we correct a tracked event — its
name, dates, or venue address. You build one small endpoint to receive it; we
handle the rest.

You don't need any access to our database or admin. You receive HTTPS \`POST\`
requests, verify a signature, and update your own copy. That's it.

## How it works

When a tracked event (or its venue) changes on our side, we send a signed
\`POST\` to a callback URL you give us. The request body is JSON; an
HMAC-SHA256 signature proves it came from us and wasn't tampered with. You
verify the signature, then apply the update to your mirror — but only if it's
newer than what you already have.

A pull-based **reconcile** endpoint is also available so you can bulk-check all
your mirrored events and self-heal anything that drifted (for example, rows
that were already stale before you onboarded).

## Getting access

Registration is operator-managed — there's no self-serve signup yet. To onboard:

1. **Email us** (the contact on our [Contact](/contact) page) and ask to become
   an **event-syndication subscriber**.
2. **Send us** your public HTTPS **callback URL** and the list of **event IDs**
   you mirror (the same IDs you already store).
3. **We give you** a **signing secret** (out of band). Store it server-side as a
   secret — never in client code or a public repo.

Once registered, corrections to any event you track start flowing automatically.

## 1. The webhook you'll receive

    POST https://your-site.example/your/callback/path
    Content-Type: application/json
    X-Syndication-Signature: sha256=<hex-hmac-of-the-raw-body>
    X-Syndication-Event-Id: <eventId>
    X-Syndication-Event-Version: <integer>

Body:

    {
      "eventId": "b8a29714-8dad-4c8b-9d40-d055be700a53",
      "eventVersion": 7,
      "name": "Gray Wild Blueberry Festival",
      "slug": "gray-wild-blueberry-festival",
      "startDate": "2026-08-15T00:00:00.000Z",
      "endDate": "2026-08-16T00:00:00.000Z",
      "venue": {
        "name": "Gray Town Common",
        "address": "1 Main St",
        "city": "Gray",
        "state": "ME",
        "zip": "04039"
      }
    }

### Fields

- **\`eventId\`** — your join key. Stable, never changes, always present.
- **\`eventVersion\`** — monotonic integer per event. Higher = newer. This is how
  you decide whether to apply an update (see §3).
- **\`name\`** — event name.
- **\`slug\`** — our URL slug (handy for linking back); may be null.
- **\`startDate\` / \`endDate\`** — ISO 8601 UTC, or null.
- **\`venue\`** — object, or null when the event has no venue. Each venue
  sub-field (\`name\`, \`address\`, \`city\`, \`state\`, \`zip\`) may individually be null.

Only these fields are mirrored. A change to anything else (description, ticket
prices, images) does **not** trigger a webhook.

### What to respond

- **\`2xx\`** (e.g. 200 / 204) = received and processed; we mark it delivered.
- **Any non-2xx, timeout, or connection error** = we **retry** with backoff (up
  to 5 attempts), then dead-letter for operator review.
- Because we retry, **you may receive the same event more than once.** Your
  handler must be idempotent (see §3) — a duplicate is normal, not an error.

## 2. Verify the signature (required)

**Algorithm:** HMAC-SHA256, key = your signing secret, message = the **raw
request body bytes exactly as received**, output = lowercase hex. Compare it to
the hex after \`sha256=\` in the \`X-Syndication-Signature\` header, using a
**constant-time** comparison.

> Sign the **raw body**, not a re-serialized object. If you parse the JSON and
> re-stringify it to compute the HMAC, key ordering and whitespace will differ
> and the signature won't match. Read the raw bytes, verify, *then* parse.

Node.js (Express):

    import crypto from "node:crypto";
    import express from "express";

    const SECRET = process.env.MMATF_SIGNING_SECRET;
    const app = express();
    app.use("/mmatf/webhook", express.raw({ type: "application/json" }));

    app.post("/mmatf/webhook", (req, res) => {
      const raw = req.body; // Buffer, from express.raw()
      const header = req.get("X-Syndication-Signature") ?? "";
      const expected =
        "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
      const ok =
        header.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
      if (!ok) return res.status(401).send("bad signature");

      applyEventUpdate(JSON.parse(raw.toString("utf8"))); // see §3
      res.status(204).end();
    });

PHP:

    $secret   = getenv('MMATF_SIGNING_SECRET');
    $raw      = file_get_contents('php://input');   // RAW body — don't json_decode first
    $header   = $_SERVER['HTTP_X_SYNDICATION_SIGNATURE'] ?? '';
    $expected = 'sha256=' . hash_hmac('sha256', $raw, $secret);
    if (!hash_equals($expected, $header)) { http_response_code(401); exit('bad signature'); }
    apply_event_update(json_decode($raw, true));    // see §3
    http_response_code(204);

> **Trust the signed body, not the headers.** The HMAC covers **only the body**,
> so the \`X-Syndication-Event-Id\` / \`-Version\` headers are *not* tamper-evident.
> Use them at most for cheap logging/routing before you parse — gate on the
> \`eventId\` and \`eventVersion\` **inside the signed body**.

## 3. Apply the update (idempotent, version-gated)

Deliveries can arrive **out of order** and **duplicated** (retries + fan-out).
The \`eventVersion\` makes this safe:

> **Rule:** highest \`eventVersion\` wins. Apply only if
> \`incoming.eventVersion > stored.eventVersion\` for that \`eventId\`. Otherwise
> ignore it (and still return 2xx).

1. Look up your mirrored row by \`eventId\`.
2. If you have it and your stored version **≥** the incoming version, do nothing.
3. Otherwise overwrite the mirrored fields (\`name\`, \`startDate\`, \`endDate\`, and
   the \`venue.*\` fields) and **store the new \`eventVersion\`** alongside them.

    function applyEventUpdate(p) {
      const existing = db.getMirroredEvent(p.eventId);
      if (existing && existing.eventVersion >= p.eventVersion) return; // stale/dup
      db.upsertMirroredEvent({
        eventId: p.eventId,
        eventVersion: p.eventVersion,   // persist this — it's the gate next time
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        venueName: p.venue?.name ?? null,
        venueAddress: p.venue?.address ?? null,
        venueCity: p.venue?.city ?? null,
        venueState: p.venue?.state ?? null,
        venueZip: p.venue?.zip ?? null,
      });
    }

The only schema change on your side is adding an **\`event_version\`** integer
column to the table that holds your mirrored events.

> **Update-only is fine.** We only ever push you events you're subscribed to, so
> "update the row I already have" is the correct model — an update that matches
> no row is a no-op. Newly-tracked events you haven't mirrored yet are covered by
> the reconcile endpoint below.

## 4. Reconcile backstop (recommended)

Push is reliable but not infallible (your endpoint could be down past the retry
window, or some rows were stale before you onboarded). So a bulk **read**
endpoint lets you re-sync on a schedule (e.g. nightly):

    POST https://meetmeatthefair.com/api/internal/syndication/batch-read
    Content-Type: application/json
    Authorization: Bearer <your signing secret>

    { "eventIds": ["<id1>", "<id2>", "…up to 200…"] }

Response — same field shape as the webhook, with \`eventVersion\`:

    {
      "success": true,
      "events": [
        { "eventId": "…", "eventVersion": 7, "name": "…", "slug": "…",
          "startDate": "…", "endDate": "…",
          "venue": { "name": "…", "address": "…", "city": "…", "state": "…", "zip": "…" } }
      ]
    }

Authenticate with \`Authorization: Bearer <your signing secret>\` — the **same
secret** that signs your webhooks; you don't need any other credential. The
response is **scoped to your subscriptions** (you only get events you track;
unknown IDs are omitted). Nightly, post your tracked IDs in batches of ≤200 and
apply each result with the same version-gated upsert from §3.

## 5. Test before go-live

Verify your receiver against production-identical deliveries **without** any
registration: configure a test secret on your endpoint and send three deliveries
— (1) a valid signed webhook, (2) a tampered signature, (3) a stale replay. You
should see **2xx → row applied at the new version**, **401 → rejected**, and
**2xx but no change → version gate held**. Ask us for the self-test script, or
reproduce those three cases yourself.

## 6. Security checklist

- [ ] Signing secret lives only server-side; never in client code or a repo.
- [ ] You verify **every** request's HMAC over the **raw** body, constant-time, and reject mismatches with \`401\`.
- [ ] You gate on \`eventId\`/\`eventVersion\` from the **signed body**, not the headers.
- [ ] Your handler is **idempotent** and **version-gated**.
- [ ] Your endpoint is **HTTPS** and publicly reachable.
- [ ] You return \`2xx\` only after durably storing the update.

## Quick reference

| Thing | Value |
| --- | --- |
| Webhook method | \`POST\` to your callback URL |
| Signature header | \`X-Syndication-Signature: sha256=<hex>\` |
| Signature algorithm | \`HMAC-SHA256(raw_body, signing_secret)\`, hex, constant-time |
| Idempotency key | \`eventId\` |
| Freshness rule | highest \`eventVersion\` wins |
| Mirrored fields | \`name\`, \`startDate\`, \`endDate\`, \`venue.{name,address,city,state,zip}\` |
| Reconcile endpoint | \`POST /api/internal/syndication/batch-read\` (Bearer = signing secret) |
| Reconcile batch limit | 200 event IDs per request |

Questions? Reach us via the [Contact](/contact) page.`;

// --- For Fairgoers ---------------------------------------------------------

const FAIRGOER_FIND_EVENTS = `Start at [Events](/events). You can browse by state — [Maine](/events/maine), [Vermont](/events/vermont), [New Hampshire](/events/new-hampshire), [Massachusetts](/events/massachusetts), [Connecticut](/events/connecticut), [Rhode Island](/events/rhode-island) — or see [all events](/events/all).

Prefer a calendar? The events page offers month, week, day, year, and schedule (agenda) views, so you can plan a weekend or scan a whole season at a glance.

The search box finds events, vendors, and venues by name — try a town name ("Kingfield"), an event ("Moxie"), or a thing you're after ("jewelry").

Want a weekly nudge instead? The **Weekend fair digest** (signup in the page footer) sends one email a week with events, new vendors, and hidden gems across New England.`;

const FAIRGOER_SAVE_EVENTS = `**Favorites:** with a free account, tap the favorite button on any event to build your personal list.

**Print a sheet:** event pages offer a printable sheet with the key details — handy for the fridge door or the glovebox.

**Add to your calendar:** event pages let you export dates to your own calendar app. Recurring fairs carry their schedule with them, so next year's dates roll in when announced.

Each event page also shows the venue with location details, the organizer, and — where available — the exhibitor list, so you know who'll be there before you go.`;

const FAIRGOER_REPORT_PROBLEM = `See a wrong date, a moved venue, a typo, or an event that isn't happening? Use [Report a problem](/report-problem) — no account needed. Tell us what's wrong and, if you can, where you saw the correct information (the organizer's website or Facebook page is ideal).

We aggregate events from many public sources and verify against organizers' own websites, but fairs change plans, and fresh eyes at ground level catch things first. Reports go into a review queue and are checked against the organizer's own published information before we change anything.

For anything else, [contact us](/contact).`;

// --- For Vendors & Exhibitors ---------------------------------------------

const VENDOR_CLAIM_LISTING = `If your business appears on Meet Me at the Fair, you can claim your listing for free. Claiming lets you edit your description, add photos, keep your contact info current, and confirm which events you're attending.

**Find your listing.** Search your business name on the [Vendors](/vendors) page. On your listing you'll see a box that says *"Is this your business?"*

**Claim it.** Click **Claim this free listing** and create an account (or sign in if you already have one).

We'll match your account against the contact details we have on file for the business. If we can't verify you automatically, [contact us](/contact) with your business name and listing link — tell us how you're connected to the business (a reply from the business's email address or website domain is the fastest proof) and we'll finish the claim manually.

**Why is my business listed if I never signed up?** We build our directory from public sources — event exhibitor lists, organizer websites, and public records — so fairgoers can find every vendor at every show. Claiming simply gives you control of what's already public. If you'd rather not be listed, see *How do I correct or remove my listing?*`;

const VENDOR_EDIT_PROFILE = `Once your listing is claimed, you can keep it current — complete profiles get found more often in search and look better to promoters assembling vendor lineups.

You can edit: your **description** (what you make or sell, in your own words), **products and categories**, **contact details** (website, email, phone), **location**, and **social links**.

A few tips that make a real difference: write the description for a fairgoer who's never heard of you; list specific products rather than broad categories ("hand-poured soy candles" beats "gifts"); and make sure your website link works — we periodically check for dead links.

If something on your listing is wrong and you haven't claimed it yet, use [Report a problem](/report-problem) — you don't need an account to send a correction.`;

const VENDOR_ADD_PHOTOS = `Photos are the single biggest upgrade you can make — listings with a logo and gallery photos get noticed.

**Logo / main image:** appears on your listing card in search results and at the top of your page. A square image works best.

**Gallery:** show your booth, your products, your work in progress. Booth photos help fairgoers recognize you at a show.

Uploaded images are automatically resized and optimized, and location metadata is stripped from them for your privacy.`;

const VENDOR_APPLY_EVENTS = `Meet Me at the Fair lists fairs, festivals, and shows across New England — and you can track which ones you've applied to in one place.

**Find candidate events.** Browse [Events](/events) by state, date, or category. Each event page lists dates, venue, and organizer details.

**Apply.** Application status on Meet Me at the Fair moves through stages you can track from your dashboard: *Interested → Applied → Approved (or Waitlisted) → Confirmed*. Organizers may also mark you *Invited*. Note that many organizers run their own application forms on their own websites — where that's the case, the event page links you out, and you can still track your status here.

**After the show**, your listing's event history builds automatically — fairgoers browsing a past event can discover your business from its exhibitor list.`;

const VENDOR_EXHIBITOR_VS_VENDOR = `We use **vendor** for any business or organization that sets up at events — crafters, food trucks, home-improvement companies, breweries, nonprofits, government outreach booths, all of it. An **exhibitor** is a vendor at a *specific* event: "the exhibitor list for the Topsfield Fair" means the vendors who were there that year.

Your single vendor listing carries your whole event history. Each event page shows its own exhibitor roster for that occurrence, so a fairgoer can see who'll be at this year's show — and who was at last year's.`;

const VENDOR_ENHANCED_PROFILE = `The standard vendor listing — and claiming it — is free, always. For vendors who want more, the **Enhanced Profile** adds premium placement and extra profile features, and **Verified Pro** adds a verification badge.

Interested? [Contact us](/contact) and we'll walk you through it.`;

// --- For Promoters ---------------------------------------------------------

const PROMOTER_CLAIM_ORG = `If you run fairs, festivals, or shows in New England, your organization likely already has a promoter page here — along with your events. Claiming it (free) lets you manage your events and see vendor applications in one place.

Find your organization on the [Promoters](/promoters) page, then use the claim link on your page — or [contact us](/contact) with your organization name. The fastest verification is an email from your organization's website domain.

**Why claim?** Your events reach fairgoers across New England either way — but claiming means the dates, hours, and details come from you, not from whatever public sources we found. Corrections at the source beat corrections after the fact.`;

const PROMOTER_LIST_EVENT = `Two paths:

**No account needed:** [Suggest an event](/suggest-event) — anyone can submit an event, and our team reviews it before it goes live. You can also email event details to us; our system reads and processes email submissions.

**With a promoter account:** create and manage listings from your dashboard, with an event wizard that walks you through dates, venue, categories, description, and images in one sitting.

Every event is reviewed for completeness before publication. The more you provide — exact dates, venue, hours, ticket info, an image — the better your listing performs.`;

const PROMOTER_MANAGE_APPLICATIONS = `Claimed promoters see applications to their events from the dashboard. Each application carries a status you control: mark vendors **Approved**, **Waitlisted**, **Confirmed**, or **Rejected**; vendors can mark themselves **Interested** or **Withdrawn**, and you can send **Invited** to vendors you want.

You can also browse the [Vendors](/vendors) directory to scout businesses for your lineup — filter by type and location, and check each vendor's event history.`;

const PROMOTER_FIX_DETAILS = `Found an error on one of your event pages? Two options:

**Fastest for a one-off:** [Report a problem](/report-problem) from the event page, or [contact us](/contact). Tell us the correct information — corrections from the organizer are treated as authoritative and applied quickly.

**Better long-term:** claim your organization (see *How do I claim my organization?*) and edit your events directly.

Because we aggregate events from public sources, occasional drift happens — a date change on your website that an old flyer contradicts, for example. We'd always rather hear it from you. That's also why claimed, promoter-maintained events carry more weight in our data-quality checks.`;

const PROMOTER_SYNDICATION = `Yes — and that's good for you. Meet Me at the Fair offers a syndication system that lets approved partner sites mirror event data with live, signed updates, so listings stay correct wherever they appear. If you (or your web developer) want your own site to stay in sync with your Meet Me at the Fair listings, see the [Event Data Syndication developer guide](/help/event-data-syndication-developer-guide).`;

// --- For Venues (placeholder — no seed content yet) ------------------------

const VENUE_COMING_SOON = `We're building help guides for venue owners and managers — how your venue pages work, what shows there, and how to keep your listing accurate.

In the meantime, if you manage a venue and want to update its details, [contact us](/contact) and we'll help directly. You can also use [Report a problem](/report-problem) to send a quick correction without an account.`;

// --- FAQ (placeholder; D1-backed version deferred to OPE-62) ---------------

const FAQ_BODY = `### What is Meet Me at the Fair?

Meet Me at the Fair is a free directory of fairs, festivals, craft shows, and community events across New England — plus the vendors who set up at them, the venues that host them, and the promoters who run them. Fairgoers use it to find events; vendors use it to find shows and be found; promoters use it to reach attendees and vendors.

### Is it free?

Yes. Browsing, favorites, the weekly digest, vendor and promoter listings, and claiming your own listing are all free. An optional paid Enhanced Profile exists for vendors who want premium placement.

### Where does the event information come from?

We aggregate from public sources — organizers' own websites, exhibitor lists, and community submissions — and verify details against the organizer's own published information. Organizers and vendors can claim their pages to control their information directly.

### Why is my business listed here? I never signed up.

Your business appeared on a public exhibitor list or other public source for an event we cover, so we listed it to help fairgoers find you. It's free publicity you can take control of: claim the listing to edit it. Prefer not to appear? Contact us and we'll take care of it.

### How do I correct or remove my listing?

To correct: claim your listing (free) and edit it, or use Report a problem for a one-off fix. To remove: contact us from an email address associated with the business and we'll process the removal.

### How do events get added? Can I add one?

Our team continuously discovers events from organizers' websites and public sources, and anyone can submit one via Suggest an Event (no account needed) — submissions are reviewed before publishing. Promoters can claim their organization to manage their events directly.

### What's the difference between a vendor, an exhibitor, and a promoter?

A vendor is a business or organization that sets up at events; an exhibitor is a vendor at a specific event; a promoter is the organization that runs the event. One organization can be both — a farm that runs its own festival and also sells at other markets.

### Does Meet Me at the Fair sell tickets?

No. Where an event is ticketed, we link you to the organizer's own ticketing. We're the directory, not the box office.

### What area do you cover?

All six New England states: Maine, New Hampshire, Vermont, Massachusetts, Connecticut, and Rhode Island — from major expos and county fairs to grange halls and church craft fairs.

### How do I stay in the loop?

Subscribe to the Weekend fair digest (one email a week, footer signup), favorite events with a free account, or export event dates to your own calendar from any event page.`;

// --- Glossary (placeholder; D1-backed version deferred to OPE-62) ----------

const GLOSSARY_BODY = `**Agricultural fair** — The classic county or state fair: livestock, agricultural exhibits and competitions, a midway, food, and entertainment, usually running multiple days. Many New England agricultural fairs are over a century old.

**Artisan market** — A recurring or one-off market focused on handmade goods, often curated. Sometimes used interchangeably with *craft fair*, though markets tend to be smaller and more frequent.

**Booth fee** — What a vendor pays the organizer for their space at an event. Varies with event size, location within the grounds, and booth size; some community events waive fees for nonprofits.

**Craft fair** — An event where artisans sell handmade goods — from a church-hall holiday sale to a multi-day juried show.

**Exhibitor** — A vendor at a specific event. An event's exhibitor list tells you who'll be (or was) there that year.

**Expo / trade show** — An exhibition where businesses show products and services to the public or to other businesses — home shows, bridal expos, boat shows. For vendors, expos are booth opportunities just like fairs.

**Grange fair** — A community fair hosted by a local Grange (an agricultural fraternal organization). Typically small, deeply local, and heavy on tradition — exhibits, suppers, and hall displays.

**Juried show** — An event where vendors apply with photos of their work and a jury selects who gets in. Juried shows keep quality and variety high; expect an application deadline well before the event.

**Load-in / load-out** — The scheduled window when vendors move their setup into (and out of) the event grounds. Organizers publish times and logistics — read them before you commit to a show.

**Midway** — The stretch of an agricultural fair with the rides, games, and classic fair food.

**Occurrence** — One year's (or one date's) running of a recurring event: "Topsfield Fair 2026" is one occurrence of the Topsfield Fair. Each occurrence has its own dates and its own exhibitor list.

**Premium book** — At agricultural fairs, the published catalog of competitions (baking, quilts, livestock, produce) and their prizes ("premiums"). If you want to enter your pie or your pumpkin, the premium book has the rules.

**Promoter** — The organization that runs an event — an agricultural society, a chamber of commerce, a professional show producer, a volunteer committee. On Meet Me at the Fair, each promoter has a page listing all its events.

**Vendor** — Any business or organization that sets up at events: crafters, food vendors, service companies, breweries, nonprofits, community groups. The Vendors directory covers them all.

**Venue** — Where events happen: fairgrounds, town commons, exhibition halls, farms. Venue pages show what's coming up at each location.`;

export const HELP_ARTICLES: HelpArticle[] = [
  // --- For Fairgoers ---
  {
    slug: "find-events-near-you",
    title: "How do I find events near me?",
    description:
      "Browse events by state or on a calendar, search by town or category, and get a weekly digest.",
    category: "For Fairgoers",
    audience: "For fairgoers",
    body: FAIRGOER_FIND_EVENTS,
  },
  {
    slug: "save-events-plan-your-visit",
    title: "How do I save events and plan my visit?",
    description: "Favorite events, print a details sheet, and export dates to your own calendar.",
    category: "For Fairgoers",
    audience: "For fairgoers",
    body: FAIRGOER_SAVE_EVENTS,
  },
  {
    slug: "report-a-problem",
    title: "Something looks wrong — how do I report it?",
    description:
      "Spot a wrong date, moved venue, or typo? Report it in a few clicks — no account needed.",
    category: "For Fairgoers",
    audience: "For fairgoers",
    body: FAIRGOER_REPORT_PROBLEM,
  },

  // --- For Vendors & Exhibitors ---
  {
    slug: "claim-your-vendor-listing",
    title: "How do I claim my vendor listing?",
    description:
      "Claim your free vendor listing to edit your details, add photos, and confirm your events.",
    category: "For Vendors & Exhibitors",
    audience: "For vendors & exhibitors",
    body: VENDOR_CLAIM_LISTING,
  },
  {
    slug: "edit-your-vendor-profile",
    title: "How do I edit my vendor profile?",
    description:
      "Keep your description, products, contact details, location, and social links current.",
    category: "For Vendors & Exhibitors",
    audience: "For vendors & exhibitors",
    body: VENDOR_EDIT_PROFILE,
  },
  {
    slug: "add-photos-to-your-listing",
    title: "How do I add photos to my listing?",
    description: "Add a logo and gallery photos so fairgoers recognize your booth and your work.",
    category: "For Vendors & Exhibitors",
    audience: "For vendors & exhibitors",
    body: VENDOR_ADD_PHOTOS,
  },
  {
    slug: "apply-to-events",
    title: "How do I apply to events?",
    description:
      "Find shows across New England and track your application status from your dashboard.",
    category: "For Vendors & Exhibitors",
    audience: "For vendors & exhibitors",
    body: VENDOR_APPLY_EVENTS,
  },
  {
    slug: "exhibitor-vs-vendor",
    title: 'What do "exhibitor" and "vendor" mean here?',
    description:
      "What vendor and exhibitor mean on Meet Me at the Fair, and how your event history works.",
    category: "For Vendors & Exhibitors",
    audience: "For vendors & exhibitors",
    body: VENDOR_EXHIBITOR_VS_VENDOR,
  },
  {
    slug: "enhanced-profile",
    title: "What are Enhanced Profiles?",
    description:
      "Optional upgrades — Enhanced Profile and Verified Pro — for vendors who want more.",
    category: "For Vendors & Exhibitors",
    audience: "For vendors & exhibitors",
    body: VENDOR_ENHANCED_PROFILE,
  },

  // --- For Promoters ---
  {
    slug: "claim-your-organization",
    title: "How do I claim my organization?",
    description:
      "Claim your promoter page (free) to manage events and vendor applications directly.",
    category: "For Promoters",
    audience: "For promoters",
    body: PROMOTER_CLAIM_ORG,
  },
  {
    slug: "list-an-event",
    title: "How do I list an event?",
    description:
      "Two ways to get your event listed — suggest one, or manage them from a promoter account.",
    category: "For Promoters",
    audience: "For promoters",
    body: PROMOTER_LIST_EVENT,
  },
  {
    slug: "manage-vendor-applications",
    title: "How do I manage vendor applications?",
    description: "Review, approve, waitlist, and confirm vendors, and scout the vendor directory.",
    category: "For Promoters",
    audience: "For promoters",
    body: PROMOTER_MANAGE_APPLICATIONS,
  },
  {
    slug: "fix-event-details",
    title: "How do I fix wrong dates, venues, or details on my event?",
    description:
      "Correct a wrong date, venue, or detail — a fast one-off fix, or claim to edit directly.",
    category: "For Promoters",
    audience: "For promoters",
    body: PROMOTER_FIX_DETAILS,
  },
  {
    slug: "event-data-syndication",
    title: "Can other websites reuse my event data?",
    description: "Let approved partner sites mirror your event data with live, signed updates.",
    category: "For Promoters",
    audience: "For promoters",
    body: PROMOTER_SYNDICATION,
  },

  // --- For Venues ---
  {
    slug: "venue-guides-coming-soon",
    title: "Venue guides are coming soon",
    description:
      "Guides for venue owners and managers are on the way — contact us in the meantime.",
    category: "For Venues",
    audience: "For venue owners & managers",
    body: VENUE_COMING_SOON,
  },

  // --- Developers ---
  {
    slug: "event-data-syndication-developer-guide",
    title: "Event Data Syndication — Developer Guide",
    description:
      "For vendors who mirror our event data on their own site: receive live, signed webhook updates so your copy never goes stale.",
    category: "Developers",
    audience: "For vendor developers integrating live event-data sync",
    body: SYNDICATION_DEVELOPER_GUIDE,
  },

  // --- FAQ (placeholder — D1-backed FAQ system deferred to OPE-62) ---
  {
    slug: "faq",
    title: "Frequently Asked Questions",
    description:
      "Common questions about Meet Me at the Fair — what it is, what it costs, and how listings work.",
    category: "FAQ",
    audience: "For everyone",
    body: FAQ_BODY,
  },

  // --- Glossary (placeholder — D1-backed glossary deferred to OPE-62) ---
  {
    slug: "glossary",
    title: "Glossary",
    description:
      "Fair-world vocabulary — from agricultural fair to venue — defined for every audience.",
    category: "Glossary",
    audience: "For everyone",
    body: GLOSSARY_BODY,
  },
];

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}

/**
 * Pure, in-memory keyword search over the help registry. HELP_ARTICLES is a
 * static TS array (NOT in D1), so this is a plain case-insensitive substring
 * match over title + description + body. Used by the site-search "Help" group.
 */
export function searchHelpArticles(
  query: string,
  limit = 5
): { slug: string; title: string; category: string }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return HELP_ARTICLES.filter((a) => {
    const haystack = `${a.title}\n${a.description}\n${a.body}`.toLowerCase();
    return haystack.includes(q);
  })
    .slice(0, Math.max(0, limit))
    .map((a) => ({ slug: a.slug, title: a.title, category: a.category }));
}
