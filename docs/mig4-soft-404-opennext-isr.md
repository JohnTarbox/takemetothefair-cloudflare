# MIG4 — soft-404 on event/venue detail pages (OpenNext ISR limitation)

**Status:** Known limitation, accepted. Last verified live 2026-06-11.

## Symptom

`GET /events/<bad-slug>` and `/venues/<bad-slug>` return **HTTP 200**, not 404.
The body is the canonical 404 page (`app/not-found.tsx`, "Page Not Found") and
carries `<meta name="robots" content="noindex">`, but the status line is 200 —
a **soft-404**.

```
curl -sI https://meetmeatthefair.com/events/zzz-does-not-exist   # -> HTTP/2 200
```

(Use a never-before-requested slug when testing — the not-found response is
edge-cached for 600s, so a repeated bad slug returns a cached 200 regardless.)

## Root cause

`events/[slug]/page.tsx` and `venues/[slug]/page.tsx` are **ISR** routes
(`export const revalidate = 300`). Both call `notFound()` when the record is
missing — in `generateMetadata` (resolves before the stream) _and_ in the page
body (defense-in-depth). Neither produces a 404 **status**.

Under `@opennextjs/cloudflare`, a `notFound()` on an **ISR / cacheable** route
renders the not-found _content_ but serves it through the incremental cache as a
cacheable **HTTP 200**. The 404 status does not propagate. This is the same
structural family as the K2 streaming-status wall (`docs/k2-spike-status-rewrite.md`):
the response status is committed by the cache/stream layer before/independent of
the framework's not-found signal.

Moving `notFound()` into `generateMetadata` (which we did) changes _which_ 404
page renders (canonical global page + reliable framework noindex instead of a
custom inline message) but does **not** change the status — confirmed live.

## Why it's accepted (not chased further)

The thing that actually matters for SEO — **keeping bogus URLs out of the
index** — is handled: Next injects `<meta robots noindex>` on the not-found
boundary, so these pages are never indexed. Google's "Soft 404" report is a
cosmetic warning, not a ranking penalty, and crawl waste is negligible (Google
doesn't crawl slugs it never discovered).

A _true_ 404 status would require one of:

1. **Drop ISR** on these routes (`dynamic = "force-dynamic"` / remove
   `revalidate`) → real 404, but loses edge caching on ~1,776 high-traffic event
   - venue pages. Net SEO/perf negative.
2. **Proxy-worker status rewrite** — detect the not-found boundary in a Worker
   in front of the app and rewrite 200→404 (the K2 apex-worker pattern). But
   that worker was retired by the OpenNext cutover and is slated for deletion;
   reviving it adds latency to every apex request.

Neither cost is justified by the marginal benefit over soft-404 + noindex.

## Revisit if

- Google Search Console's **Soft 404** report grows materially for
  `/events/*` or `/venues/*`, **or**
- `@opennextjs/cloudflare` ships proper `notFound()` status propagation for ISR
  routes (then just confirm with the `curl -sI` above — no code change needed).
