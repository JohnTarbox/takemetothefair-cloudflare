# MIG4 / OPE-420 — soft-404 on event/venue/vendor pages

**Status: FIXED (OPE-420, 2026-08-17).** This document previously recorded the
issue as an accepted, unfixable OpenNext limitation. **That diagnosis was
wrong.** The corrected analysis is below, kept in full because the wrong version
was cited for two months and the reasoning error is worth not repeating.

## Symptom (historical)

`GET /events/<bad-slug>`, `/venues/<bad-slug>` and `/vendors/<bad-slug>`
returned **HTTP 200** carrying the canonical 404 page — right `<title>`, right
`noindex`, no schema. Only the status line was wrong. `/blog/<bad-slug>` and
`/promoters/<bad-slug>` returned a correct 404 throughout.

Because `/events/[slug]/[year]` accepts **any** second segment, the soft-404
surface was effectively unbounded.

## What the previous version of this doc claimed — and why it was wrong

> "Under `@opennextjs/cloudflare`, a `notFound()` on an ISR / cacheable route
> renders the not-found content but serves it as a cacheable HTTP 200… A true
> 404 status would require dropping ISR or reviving a proxy worker. Neither cost
> is justified."

Three things were wrong with that:

1. **It is not an OpenNext behaviour.** The bug reproduces **identically on a
   plain local `next dev` server** — same six routes, same three 200s and three
   404s. Nothing Cloudflare-specific is involved.
2. **ISR was explicitly ruled out by the evidence in front of us.** `blog` and
   `promoters` are also `revalidate = 300` ISR routes with `notFound()`, and
   they always returned 404. A cause that does not separate the working cases
   from the broken ones is not the cause.
3. **The stated cost was imaginary.** The fix required neither dropping ISR nor
   a proxy worker, and cost no caching at all.

## Actual root cause

A **`loading.tsx`** file existed at `src/app/events/`, `src/app/venues/` and
`src/app/vendors/` — and nowhere else in the app. Those are exactly the three
broken families.

`loading.tsx` creates an implicit **Suspense boundary** over its own segment
_and every descendant_. Next.js then **streams** the response: the HTTP status
line is flushed before the page body runs and reaches `notFound()`. Once the
stream has started with a 200, the status cannot be changed. The not-found UI
still renders — hence a correct body with a wrong status.

`blog`, `promoters` and `performers` had no `loading.tsx`, did not stream, and
so could still set a 404.

This is the "K2 streaming-status wall" the old version of this doc gestured at
(`docs/k2-spike-status-rewrite.md`) — but it misattributed the streaming to ISR
rather than to `loading.tsx`.

### The one experiment that settled it

Two hypotheses each correlated 6/6 with the defect: `loading.tsx`, and a
`Cloudflare-CDN-Cache-Control` header applied by `next.config.mjs` to exactly
`/events/:path*`, `/venues/:path*`, `/vendors/:path*`. Correlation could not
separate them.

`/venues/aa/bb` did. It matches the header rule but has **no matching route**,
so Next 404s in the router before any segment boundary is involved — and it
returned a correct 404. That killed the header hypothesis. Deleting the three
`loading.tsx` files locally then flipped all three families to 404, confirming
the other.

(The header is separately **inert**: no `cf-cache-status` appears on any
Worker-served page, including `/` and `/about`, while it does appear on
`/favicon.ico`. Worker routes are the origin, so the response never passes back
through the CDN cache. Not harmful, but it is not buying the caching the
OpenNext migration plan assumed.)

## The fix

Scope each Suspense boundary to a **`(listing)` route group** containing only
fixed listing paths, leaving the dynamic `[slug]` routes outside it. Route
groups are URL-invisible, so no path changed and every loading skeleton was
kept:

```
src/app/events/(listing)/{page.tsx, loading.tsx, all, craft-fairs, maine, …}
src/app/events/[slug]/…                 ← outside the boundary
src/app/events/massachusetts/[facet]/…  ← outside (owns a dynamic child)
src/app/venues/(listing)/{page.tsx, loading.tsx}
src/app/venues/{[slug], browse}/…       ← outside (browse owns [letter]/[state])
```

`massachusetts/`, `connecticut/` and `browse/` sit outside their groups because
each contains a dynamic segment of its own. They lose the skeleton; their
listing pages are ISR-cached and render from cache, so the loss is not visible.

## Guardrails

- `src/__tests__/no-loading-boundary-over-dynamic-routes.test.ts` fails the unit
  suite if a `loading.tsx` is ever added at or above a dynamic segment. This is
  what found the four extra `browse/letter/[letter]` and `browse/state/[state]`
  routes that the ticket had not spotted.
- `e2e/soft-404.spec.ts` asserts the **status line** on bogus slugs, and asserts
  the listing URLs still resolve so a "fix" cannot just delete the skeletons.

Both matter: the original defect was invisible to every check that inspected the
HTML, because the HTML was always right.
