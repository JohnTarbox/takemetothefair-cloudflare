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

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "event-data-syndication-developer-guide",
    title: "Event Data Syndication — Developer Guide",
    description:
      "For vendors who mirror our event data on their own site: receive live, signed webhook updates so your copy never goes stale.",
    category: "Developers",
    audience: "For vendor developers integrating live event-data sync",
    body: SYNDICATION_DEVELOPER_GUIDE,
  },
];

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}
