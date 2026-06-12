# Meet Me at the Fair — Event Syndication: Consumer Integration Guide

**Audience:** the developer maintaining the Maine Cardworks "Find us in person" site (or any
site that mirrors event data from Meet Me at the Fair / MMATF).

**Why you're reading this:** today your site stores a one-time copy of each event's details
(name, dates, venue address). When MMATF later corrects something — e.g. a venue's city was
fixed from **"Grey, ME"** to **"Gray, ME"** — your copy never finds out and silently goes stale.

MMATF now **pushes every correction to you** as a signed webhook within minutes, and offers a
**pull endpoint** so you can re-sync in bulk as a safety net. This guide is everything you need
to build the receiving side. **You do not need any access to MMATF's database or admin** — you
receive HTTP POSTs and (optionally) make HTTP GETs.

> **Two-way separation is intentional.** MMATF pushes corrections _to you_; it never reads or
> writes your site. Your receiver applies updates to _your own_ mirror copy only.

---

## TL;DR — what you need to build

1. **One HTTPS endpoint** on your site that receives `POST` webhooks (the "callback URL").
2. In that endpoint: **verify the HMAC signature**, then **apply the payload** to your mirrored
   copy of that event — but only if it's **newer** than what you already have.
3. Give us your **callback URL**; we give you a **signing secret**. Tell us which **event IDs**
   you mirror.
4. _(Recommended, not required)_ a **nightly reconcile job** that bulk-checks all your mirrored
   events against MMATF and fixes any that drifted.

---

## 1. The webhook you will receive

When a tracked event (or its venue/date) changes, MMATF sends:

```
POST https://your-site.example/your/callback/path
Content-Type: application/json
X-Syndication-Signature: sha256=<hex-hmac-of-the-raw-body>
X-Syndication-Event-Id: <eventId>
X-Syndication-Event-Version: <integer>
```

> ⚠️ **The headers are informational only — they are NOT covered by the HMAC.** Only the request
> **body** is signed. Use `X-Syndication-Event-Id` / `-Version` (and `Content-Type`) at most for
> cheap routing/logging _before_ you parse; never make a security or version-gating decision on a
> header value. **Gate on the `eventId` and `eventVersion` _inside the signed body_** (§3) — those
> are the authoritative, tamper-evident values. (You can ignore the `X-Syndication-Event-*`
> headers entirely and lose nothing.)

### Request body

```json
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
```

### Field reference

| Field                                | Type           | Notes                                                                                |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------------ |
| `eventId`                            | string         | **Your join key.** Stable, never changes. Always present.                            |
| `eventVersion`                       | integer        | **Monotonic per event.** Higher = newer. Use it to decide whether to apply (see §3). |
| `name`                               | string         | Event name.                                                                          |
| `slug`                               | string \| null | URL slug on MMATF; handy if you link back. May be null.                              |
| `startDate`                          | string \| null | ISO 8601 UTC, or null if unset.                                                      |
| `endDate`                            | string \| null | ISO 8601 UTC, or null.                                                               |
| `venue`                              | object \| null | `null` when the event has no venue. Otherwise the object below.                      |
| `venue.name`                         | string \| null | Each venue sub-field may individually be null.                                       |
| `venue.address`/`city`/`state`/`zip` | string \| null | The mirrored address fields.                                                         |

> **Only these fields are mirrored.** Description, ticket prices, images, etc. are intentionally
> not pushed — a change to one of those will **not** trigger a webhook.

### What you must respond

- **`2xx`** (e.g. `200`/`204`) = "received and processed." We mark the delivery done.
- **Any non-2xx, a timeout, or a connection error** = we **retry** with backoff (up to 5
  attempts). Persistent failures land in a dead-letter queue for the MMATF operator to review.
- Because we retry, **you may receive the same event more than once** — your handler must be
  **idempotent** (see §3). That's by design; don't treat a duplicate as an error.

---

## 2. Verify the signature (required)

Every request is signed so you can trust it came from MMATF and wasn't tampered with.

**Algorithm:** `HMAC-SHA256`, key = your `signing_secret`, message = the **raw request body
bytes exactly as received**, output = lowercase hex. Compare that to the hex after `sha256=` in
the `X-Syndication-Signature` header, using a **constant-time** comparison.

> ⚠️ **Sign the raw body, not a re-serialized object.** If you `JSON.parse` the body and then
> re-`stringify` it to compute the HMAC, key ordering/whitespace will differ and the signature
> won't match. Read the raw body string/bytes first, verify, _then_ parse.

### Node.js / TypeScript (Express)

```ts
import crypto from "node:crypto";
import express from "express";

const SIGNING_SECRET = process.env.MMATF_SIGNING_SECRET!; // the secret we give you

const app = express();

// Capture the RAW body for signature verification.
app.use("/mmatf/webhook", express.raw({ type: "application/json" }));

app.post("/mmatf/webhook", (req, res) => {
  const rawBody = req.body as Buffer; // Buffer because of express.raw()
  const header = req.get("X-Syndication-Signature") ?? "";

  const expected =
    "sha256=" + crypto.createHmac("sha256", SIGNING_SECRET).update(rawBody).digest("hex");

  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  const ok =
    header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  if (!ok) return res.status(401).send("bad signature");

  const payload = JSON.parse(rawBody.toString("utf8"));
  applyEventUpdate(payload); // your upsert — see §3
  return res.status(204).end();
});
```

### PHP

```php
<?php
$secret  = getenv('MMATF_SIGNING_SECRET');     // the secret we give you
$raw     = file_get_contents('php://input');   // RAW body — do not json_decode first
$header  = $_SERVER['HTTP_X_SYNDICATION_SIGNATURE'] ?? '';
$expected = 'sha256=' . hash_hmac('sha256', $raw, $secret);

if (!hash_equals($expected, $header)) {        // constant-time compare
    http_response_code(401);
    exit('bad signature');
}

$payload = json_decode($raw, true);
apply_event_update($payload);                  // your upsert — see §3
http_response_code(204);
```

---

## 3. Apply the update (idempotent, version-gated)

You will receive deliveries that are **out of order** and **duplicated** (both are normal — they
come from retries and fan-out). The `eventVersion` field makes this safe to handle:

> **Rule: highest `eventVersion` wins. Apply only if `incoming.eventVersion > stored.eventVersion`
> for that `eventId`. Otherwise ignore it.**

Steps for your handler:

1. Look up your mirrored row by `eventId`.
2. If you have it and your stored version **≥** the incoming `eventVersion`, **do nothing** (it's
   a stale or duplicate delivery) and still return `2xx`.
3. Otherwise, overwrite your mirrored fields (`name`, `startDate`, `endDate`, and the `venue.*`
   fields) with the payload, and **store the new `eventVersion`** alongside them.
4. Return `2xx`.

```ts
function applyEventUpdate(p) {
  const existing = db.getMirroredEvent(p.eventId); // your storage
  if (existing && existing.eventVersion >= p.eventVersion) return; // stale/dup → skip

  db.upsertMirroredEvent({
    eventId: p.eventId,
    eventVersion: p.eventVersion, // <-- persist this; it's the gate for next time
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
```

You will need to **add an `event_version` column** (integer) to whatever table holds your
mirrored events, if you don't already track one. It's the only schema change required.

---

## 4. Registration — what we exchange

Adding you as a subscriber is a single record on the MMATF side; no deploy. We need:

1. **Your callback URL** — the public HTTPS endpoint from §1 (e.g.
   `https://mainecardworks.example/mmatf/webhook`).
2. **The list of MMATF event IDs you mirror** — these are the `eventId` values (the same IDs that
   appear in the webhook and in your existing copied data). Send us the set you currently track;
   we'll subscribe you to each. You can ask us to add/remove IDs anytime.

We will give you, **out of band** (not over email/chat in plaintext):

3. **Your `signing_secret`** — store it as a server-side secret/env var (`MMATF_SIGNING_SECRET`
   above). Never expose it client-side. If it leaks, tell us and we'll rotate it.

---

## 5. Reconcile backstop (recommended)

Push delivery is reliable but not infallible — if your endpoint is down past our retry window, or
some of your rows were already stale _before_ this system existed (like the current "Grey" row),
push alone won't fix them. So MMATF exposes a **bulk read** endpoint you can poll on a schedule
(e.g. nightly) to self-heal.

```
POST https://meetmeatthefair.com/api/internal/syndication/batch-read
Content-Type: application/json
Authorization: Bearer <your signing_secret>

{ "eventIds": ["<id1>", "<id2>", "…up to 200…"] }
```

**Response:**

```json
{
  "success": true,
  "events": [
    {
      "eventId": "b8a29714-…",
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
  ]
}
```

Same field shape as the webhook. **Unknown IDs are simply omitted** from the response (treat a
missing ID as "deleted/unknown on MMATF" and handle on your side).

**Nightly reconcile loop:**

1. POST your tracked event IDs (batches of ≤200).
2. For each returned event, apply the **same version-gated upsert** as §3 (`eventVersion >`
   stored → overwrite). This quietly repairs any row that drifted.
3. Log anything you corrected, so we can both see if push is missing deliveries.

> **Auth for this endpoint:** send `Authorization: Bearer <your signing_secret>` — the **same
> secret** we give you for verifying webhooks (§2). You don't need any MMATF internal key. The
> response is **scoped to your subscriptions**: you'll only ever get back events you're subscribed
> to, and any requested ID you don't track is simply omitted. (The push webhook in §1–§3 needs
> **no** credential from you at all — it's the primary path and works the moment you're
> registered.)

---

## 6. Testing before go-live

1. Stand up your callback endpoint (even returning `204` and logging is enough to start).
2. Ask John to register a **throwaway test subscriber** pointing at your endpoint (or a
   [webhook.site](https://webhook.site) URL) and subscribe it to one event.
3. John edits that event's name (or its venue's city) in MMATF → you should receive a signed
   `POST` within a couple of minutes.
4. Confirm your signature check passes against the raw body, and that a **second** identical
   delivery is correctly **ignored** by your version gate.
5. Point it at your real endpoint and go live.

---

## 7. Security checklist

- [ ] `signing_secret` lives only server-side (env var / secret store), never in client code or
      a public repo.
- [ ] You verify **every** request's HMAC over the **raw** body, with a **constant-time** compare,
      and reject mismatches with `401`.
- [ ] Your handler is **idempotent** and **version-gated** (`eventVersion >` stored → apply).
- [ ] You gate on `eventId`/`eventVersion` **from the signed body**, not the (unsigned) headers.
- [ ] Your endpoint is **HTTPS** only.
- [ ] You return `2xx` only after you've durably stored the update (so a crash mid-handler leads
      to a retry, not a silent loss).

---

## Quick reference

| Thing                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| Webhook method            | `POST` to your callback URL                                                  |
| Signature header          | `X-Syndication-Signature: sha256=<hex>`                                      |
| Signature algorithm       | `HMAC-SHA256(raw_body, signing_secret)`, hex, constant-time compare          |
| Idempotency key           | `eventId`                                                                    |
| Freshness rule            | highest `eventVersion` wins                                                  |
| Mirrored fields           | `name`, `startDate`, `endDate`, `venue.{name,address,city,state,zip}`        |
| Reconcile (pull) endpoint | `POST https://meetmeatthefair.com/api/internal/syndication/batch-read`       |
| Reconcile auth            | `Authorization: Bearer <your signing_secret>` (scoped to your subscriptions) |
| Reconcile batch limit     | 200 event IDs per request                                                    |

Questions → John.
