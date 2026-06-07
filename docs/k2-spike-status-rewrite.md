# K2 spike — Worker-level HTTP 5xx on Server Component data-fetch failure

**Status:** spike output, no code shipped. Decides which implementation path K2's iteration takes.

**Owner:** John

**Date:** 2026-06-07

## The goal

When a public page's data fetcher throws (e.g. `getEvents` against D1 fails), today's behavior is:

1. The fetcher throws `FetchError` (REL1' §1, PR #332 + #364 — 9 page files now thrown-on-failure)
2. Next.js App Router catches the throw and renders `src/app/error.tsx` ("Service temporarily unavailable")
3. **The HTTP response is 200.**

The 200 is the bug. The page LOOKS broken to a human, but a crawler / monitor / smoke-check sees a successful response. The 2026-06-04 D1 100-col outage went 17 hours undetected for exactly this reason: every observability layer was status-aware, none were content-aware. The K1 / REL1' work made the error UI distinguishable visually but didn't change the status.

K2's stated acceptance from the 2026-06-07 backlog email:

> - A `getEvents` throw renders the error UI AND returns HTTP 500 from the edge — crawlers + monitoring + the existing post-deploy smoke test (PR #332's B5) see the 5xx
> - `error.tsx` for non-fatal client-side errors continues to render 200 (don't 5xx everything)
> - Pages without fetcher errors continue to render 200 (sentinel default is unset)

## What the email proposed (and what's actually possible)

### Option (a) from the email — "Response-header sentinel + middleware rewrite"

> Route handlers set a `X-Render-Error: 1` sentinel header on the response when a fetcher threw and was caught into the error UI. `middleware.ts` inspects the sentinel and rewrites the status from 200 to 500.

**Spike finding: this option is structurally impossible in Next.js 15 App Router as described.**

Three reasons:

1. **In App Router, public pages aren't route handlers** — they're Server Components (`app/<surface>/page.tsx`). Server Components have no canonical API for setting response headers. `next/headers.headers()` is a READER, not a setter.

2. **`error.tsx` is a client component** (`"use client"` directive is required by Next.js). It runs in the browser AFTER the response is sent. It can't influence the initial response status.

3. **Middleware can't read the rendered response either.** `NextResponse.next()` lets the request flow to the page renderer, but middleware returns BEFORE the page renders — so it can't inspect a sentinel header the renderer would set after the fact.

There's a Next.js framework mechanism for status-code-from-Server-Component throws: `notFound()` / `forbidden()` / `unauthorized()` throw sentinel errors carrying a status digest. The framework reads it and emits the matching response. But the allowed-codes set is hardcoded:

```js
// node_modules/next/dist/client/components/http-access-fallback/http-access-fallback.js
const HTTPAccessErrorStatus = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
};
const ALLOWED_CODES = new Set(Object.values(HTTPAccessErrorStatus));
```

500 is not a member. Throwing a sentinel with `;500` in its digest fails framework validation.

### Option (b) from the email — "Move fetcher-error handling into route handlers returning `Response` objects"

> Fetcher throws are caught at the route-handler level (not the error boundary); the handler returns `new Response(errorHTML, { status: 500 })`.

**Spike finding (2026-06-07, after starting the PoC on `/vendors`): this option is structurally incompatible with Next.js 15 App Router for our existing pages.**

Three concrete blockers surfaced while reading `src/app/vendors/page.tsx` against `route.ts` semantics:

1. **`page.tsx` and `route.ts` cannot coexist at the same URL.** App Router treats them as competing handlers for the same segment; the framework errors at build. So conversion is destructive: delete `page.tsx`, write `route.ts`.

2. **Next.js doesn't expose React Server Components rendering as a public API for use inside route handlers.** A route handler can call `react-dom/server.renderToReadableStream`, but that's vanilla React — it doesn't understand RSC, doesn't run client-component hydration markers correctly, and bypasses the framework's metadata-injection + layout-composition pipeline. There is no public `renderPageAsString(segment)` helper.

3. **The 9 page files that throw `FetchError` aren't isolated leaves.** They consume:
   - The `Metadata` API (`export const metadata`) — Next.js auto-injects head tags from this. A route handler that returns a `Response` must manually emit `<title>`, `<meta>`, `<link rel="canonical">`, OpenGraph/Twitter cards from scratch.
   - ISR via `export const revalidate` (e.g. `3600` on `/vendors`). Route handlers don't participate in static caching the same way; the page goes from edge-cached HTML to per-request render.
   - Nested layouts (RootLayout + any `app/<segment>/layout.tsx`). Layouts wrap `page.tsx` automatically; route handlers must compose them manually.
   - Client components nested in the page tree (e.g. `MobileFilterDrawer`, `VendorsView` on `/vendors`). Their hydration relies on RSC framework markers that vanilla `renderToReadableStream` doesn't emit.

The route-handler conversion would need to re-implement all of the above per-page. The result would be visibly inferior to today's pages (no streaming, no metadata API, slower TTFB without ISR) AND have the same surface area as today's page.tsx — a true regression.

**Empirical PoC finding**: I started the conversion on `/vendors` and stopped after reading the source. The conversion would produce ~150 LOC of manual layout/metadata/RSC composition per page (× 9 pages = ~1350 LOC of framework-shadow code) for the same user-facing surface. That's a net architecture regression, not a fix.

**Recommendation against (b).** Pivot to (c) below.

### Option (c) — Cloudflare Pages Worker post-processing (spike's recommendation)

Add a small worker layer that runs AFTER Next.js has rendered the page. The worker:

1. Reads the response body's first ~512 bytes
2. Looks for the K1 error-UI marker text (e.g. `"Service temporarily unavailable"`, the H1 in `error.tsx`)
3. If found, rewrites the response status from 200 to 500 (or 503 for transient-looking errors)

Implementation surface: extending the existing `src/middleware.ts` (which already handles 5 pre-route concerns) OR a `_worker.js` in the Pages output. The middleware path is preferred because it already exists.

Pros:

- Tiny diff (~30 LOC in middleware)
- Doesn't touch any page files
- Doesn't fight the framework — works WITH the existing error.tsx
- Sentinel-default is "off" automatically: a page that doesn't render the error UI has no marker text, response stays 200

Cons:

- Body inspection adds a small CPU cost on every public response (~20 µs to scan a stream's first 512 bytes; need to test)
- Fragile against error.tsx UI changes — if the H1 text changes and the marker grep isn't updated, the rewrite silently stops firing. Solvable with a hidden `<meta>` tag that's harder to drift than visible UI text.
- Cloudflare middleware needs to handle `NextResponse.next()` → response inspection pattern. Need to verify next-on-pages plays well with the modification.

The right marker: NOT visible UI text (fragile). Add an invisible `<meta name="x-render-error" content="fetch">` tag inside `error.tsx`'s top-level div. The grep stays stable across UI rewrites.

### Option (d) — Extend the B5 smoke check to be content-aware

Lowest-effort, no production behavior change. The B5 smoke today only verifies status 200 on `/venues/abbot-square` and `/promoters/american-consumer-shows`. Extending each to also `grep -v 'Service temporarily unavailable'` would catch error-UI rendering with the same content-check pattern already used for `/events`.

Pros:

- ~5 LOC change in `.github/workflows/deploy.yml`
- Catches the post-deploy outage scenario (the 2026-06-04 case)
- Zero risk to production routing

Cons:

- Crawlers still see 200 — Google's soft-404 detection eventually flags the URLs but takes days
- Monitoring (CDN cache rules, uptime checks) still sees 200 — no alerting unless they're also content-aware
- Doesn't satisfy the email's "crawlers see 5xx" acceptance

Reasonable to ship alongside (c) as belt-and-braces.

## Comparison table

| Option                       | Crawlers see 5xx | Smoke catches | Effort            | Diff size                | Risk                                    |
| ---------------------------- | ---------------- | ------------- | ----------------- | ------------------------ | --------------------------------------- |
| (a) header sentinel          | —                | —             | not implementable | —                        | —                                       |
| (b) route handler conversion | ✅               | ✅            | 2-3 days          | ~9 files × ~150 LOC each | Medium (touches every public page)      |
| (c) middleware body-scan     | ✅               | ✅            | ½ day             | ~30 LOC                  | Low (additive middleware, marker-based) |
| (d) B5 content-aware         | ❌ (smoke only)  | ✅            | ½ hr              | ~10 LOC                  | Very low (CI workflow only)             |

## Spike recommendation

**Ship (c) + (d) together** as the K2 iteration. Both (a) and (b) from the email are structurally incompatible with Next.js 15 App Router for the existing 9 pages:

- (a): Server Components have no response-header API; middleware can't see the rendered response
- (b): `page.tsx` and `route.ts` can't share a URL; route handlers don't have RSC rendering; conversion produces ~1350 LOC of framework-shadow code that loses RSC streaming + metadata API + ISR for no net user benefit

The pragmatic paths that hit the K2 acceptance:

- (c) gets the email's acceptance: crawlers + monitoring see 5xx, smoke check status-fails on error UI
- (d) is a belt-and-braces fallback that costs almost nothing and provides redundant coverage

If Next.js eventually ships a `serverError()` framework primitive (the natural extension of `notFound()` / `forbidden()` / `unauthorized()`), the page handlers can migrate to that. The 9 `FetchError` throws already provide the typed signal — a future migration would be a 1-line-per-file change. (c)'s middleware indirection is a forward-compatible bridge.

**Key edge cases to handle in (c):**

1. **CDN cache.** `next.config.mjs` lines 56-60 cache `/`, `/events/*`, `/venues/*`, `/vendors/*` at the CDN for 10 min + 5 min SWR. A 500 response MUST set `Cache-Control: no-store` to bypass the CDN — otherwise the CDN caches the 500 and serves it to everyone for 10 min even after the underlying DB recovers. The middleware must override cache-control headers when rewriting status.

2. **Streaming responses.** Next.js may stream the response. Reading the first 512 bytes of the stream requires consuming part of it, then re-emitting. Worth testing on a known-streaming route.

3. **Marker location.** Adding `<meta name="x-render-error" content="fetch">` to `error.tsx`'s top-level div places the marker in the SSR'd HTML's head/early body, which streams first — middleware reads it without consuming much of the body.

4. **error.tsx for client-side errors.** The acceptance says "non-fatal client-side errors continue to render 200." The marker would fire for ALL error.tsx renders, including non-FetchError ones. Fix: check `error.name` in error.tsx and only emit the marker for `name === "FetchError"`. The `isFetchError` check at `src/app/error.tsx:26` is already gating other UI; just gate the marker the same way.

5. **`global-error.tsx`.** This is the OUTER boundary that catches layout-level throws. It should also emit the marker. Its current status code is also 200; the rewrite handles it uniformly.

## What this brief leaves open

- The exact middleware diff for (c) — sketched as "read first 512 bytes, grep marker, rewrite status + cache-control"; needs to be written and tested
- The marker convention — recommend `<meta name="x-render-error" content="fetch">` but the actual choice can be reviewed
- next-on-pages middleware response-inspection behavior — needs an empirical test in a CF Pages preview before committing to (c)
- (d)'s diff for `deploy.yml`'s B5 step — trivial but should be written + tested in CI before relying on it

## Related

- PR #332 — REL1' §1: FetchError class + 4 fetchers converted (2026-06-04)
- PR #364 — K2 framing extension: 5 more fetchers converted (2026-06-06)
- Memory: `[[project_page_error_canary]]` — the page-error Slack canary that complements this work
- Source:
  - `src/lib/errors/fetch-error.ts`
  - `src/app/error.tsx`, `src/app/global-error.tsx`
  - `src/middleware.ts` (5 existing pre-route concerns; adding a 6th)
  - `.github/workflows/deploy.yml` lines 103-134 (B5 smoke)
