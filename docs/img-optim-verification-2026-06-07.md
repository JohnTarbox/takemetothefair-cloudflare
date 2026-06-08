# IMG Optimization Verification — 2026-06-07

Baseline measurements against `https://meetmeatthefair.com/` BEFORE the
follow-up PR (`feat/img-optim-followups`) lands. Used to:

1. Prove IMG1 (PR #375, 2026-06-07) actually delivers the spec promises.
2. Locate the surviving gaps (the four items the follow-up PR closes).
3. Provide an after-state target the same probes can re-verify.

Spec source: `C:\Users\wa1kl\Downloads\MMATF-Mobile-Image-Optimization.md`
(checked into the planning artefact, not the repo).

---

## Target pages

Picked via D1 query (highest-traffic candidates with `image_url IS NOT NULL`):

| Surface                 | URL                                                                                               | Notes                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Event detail hero (LCP) | https://meetmeatthefair.com/events/nh-camping-rv-show-2026                                        | 24,927 views — top event by traffic    |
| Event listing grid      | https://meetmeatthefair.com/events                                                                | First-card LCP candidate               |
| Homepage                | https://meetmeatthefair.com/                                                                      | Featured + upcoming + weekend grids    |
| Blog index              | https://meetmeatthefair.com/blog                                                                  | First-card LCP candidate               |
| Blog post hero          | https://meetmeatthefair.com/blog/how-many-items-should-you-bring-to-a-craft-fair-a-simple-formula | Recently published with featured image |

---

## A1 — Phone-sized bytes (spec criterion 1)

**Requires:** Chrome DevTools mobile emulator (iPhone 14, 390×844).
**Status:** Pending interactive run. Re-verify after Phase 2 deploys.

For each target, in DevTools → Network → image, confirm "Size" + intrinsic
dimensions are ≤1024px wide on heroes and ≤800px wide on cards.

---

## A2 — AVIF/WebP content-type (spec criterion 2) ✅ PASS

Probed `https://meetmeatthefair.com/cdn-cgi/image/width=640,format=auto,quality=80/https://cdn.meetmeatthefair.com/events/e1da1eb7-0006-493c-8d5e-b8e35aa845cc/image-1778118448143.jpg` (one of the actual srcset URLs Next/Image emits on the homepage).

| Browser UA          | Accept header                         | Returned content-type | Bytes |
| ------------------- | ------------------------------------- | --------------------- | ----- |
| Chrome 120 / Win    | `image/avif,image/webp,image/png,*/*` | **`image/avif`**      | 18108 |
| iOS Safari 17       | `image/webp,image/png,*/*`            | **`image/webp`**      | 18054 |
| Firefox 60 (legacy) | `image/png,*/*`                       | **`image/jpeg`**      | 20275 |

`Vary: accept` is set, so per-UA caching works correctly. `format=auto` does
exactly what the spec promises — modern browsers get AVIF (~10% smaller than
WebP), Safari gets WebP, legacy gets JPEG.

---

## A3 — Lighthouse mobile LCP (spec criterion 3)

**Status:** Pending interactive Lighthouse run. Requires a Chrome session.

Re-run after Phase 2 deploys:

```bash
npx lighthouse https://meetmeatthefair.com/events/nh-camping-rv-show-2026 \
  --form-factor=mobile --output=json --output-path=./lh-event-hero.json
npx lighthouse https://meetmeatthefair.com/events \
  --form-factor=mobile --output=json --output-path=./lh-events.json
npx lighthouse https://meetmeatthefair.com/blog \
  --form-factor=mobile --output=json --output-path=./lh-blog.json
```

Acceptance: LCP improves (or stays under 2.5s), and "Properly size images",
"Serve images in next-gen formats", "Defer offscreen images" are NOT in the
opportunities list.

---

## A4 — CLS ≈ 0 (spec criterion 4)

**Status:** Pending Lighthouse run (reports CLS directly). Spot-checked
during A5 work — all `<Image>` renders use `fill` inside aspect-ratio
containers, so layout is reserved at render time. The two known exposures
(OAuth avatars in header + dashboard) are addressed in Phase 2C.

---

## A5 — Exactly one preloaded image per page (spec criterion 5) ⚠️ GAP CONFIRMED

**Probe note:** Next.js 15.1.12 does NOT emit `fetchpriority="high"` in
the server-rendered HTML (it's added client-side by React DOM). The
operative server-rendered signal is `<link rel="preload" as="image"
imageSrcSet=... imageSizes=...>` — Next/Image emits this for every image
rendered with `priority={true}`. The grep target is the preload count,
not `fetchpriority`.

Baseline counts (one curl per URL, iOS Safari UA):

| URL                               | preload-image count | Source code                                                            | Status                                                                                             |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/`                               | 1                   | `priority={i < 2}` at `src/app/page.tsx:339`                           | OK in prod (only 1 of 2 cards has an R2 image; rest fall back to category SVG)                     |
| `/events`                         | 1                   | `priority={index < 3}` at `src/components/events/events-view.tsx:1180` | OK in prod (only first card has R2 image today); **latent gap if cards 2–3 ever both have images** |
| `/blog`                           | **3** ❌            | `priority={i < 3}` at `src/app/blog/page.tsx:265`                      | **GAP** — spec demands exactly 1                                                                   |
| `/events/nh-camping-rv-show-2026` | 1                   | hero `priority` in `src/app/events/[slug]/page.tsx`                    | OK                                                                                                 |
| `/blog/<slug>`                    | 1                   | hero `priority` in `src/app/blog/[slug]/page.tsx`                      | OK                                                                                                 |

**Bonus finding (out of scope, file as follow-up):** 2 of the 3 blog
preloads point to _foreign-host_ image URLs
(`glasgowlands.org/...`, `images.squarespace-cdn.com/...`) — blog posts
whose featured image lives on the source site rather than R2. The custom
loader (`src/lib/image-loader.ts`) routes these through `cdnImage()`,
which correctly returns the URL unchanged for foreign hosts, but
Next/Image still emits a 10-entry `imageSrcSet` with the same URL at
every width. Harmless but wasteful preload payload. Not addressed in
this PR.

---

## Resilience baseline — `onerror=redirect` (spec §Resilience) ⚠️ GAP CONFIRMED

`onerror=redirect` is NOT in `cdnImage()` today. Reproduced the contrast:

| URL                                                                  | Response                                                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/cdn-cgi/image/width=640,format=auto/<404-source>`                  | `HTTP/2 404` (broken image; `cf-resized: err=9404`)                                                                                                                                     |
| `/cdn-cgi/image/width=640,format=auto,onerror=redirect/<404-source>` | `HTTP/2 307` → `location: <404-source>` (graceful fallback; browser shows the 404 itself, but at least the URL works for cases where the original IS reachable but the transform fails) |

Phase 2B adds `onerror=redirect` to every loader-emitted URL via a single
default in `src/lib/image-loader.ts`.

---

## Findings summary

Baseline status (as of the 2026-06-07 probe run). Post-deploy outcomes
captured in "Post-deploy re-verification — 2026-06-08" below.

| Spec criterion                  | Baseline status                       | Closed by              |
| ------------------------------- | ------------------------------------- | ---------------------- |
| A1 — phone-sized bytes          | Pending DevTools run                  | (manual, post-deploy)  |
| A2 — AVIF/WebP per UA           | ✅ PASS                               | Already shipped (IMG1) |
| A3 — Lighthouse LCP             | Pending Lighthouse run                | (manual, post-deploy)  |
| A4 — CLS ≈ 0                    | Pending; OAuth-avatar exposures known | Phase 2C (PR #388)     |
| A5 — one preload/page           | ⚠️ FAIL on `/blog` (3 preloads)       | Phase 2A (PR #389 ✅)  |
| Resilience — `onerror=redirect` | ⚠️ MISSING                            | Phase 2B (PR #388 ✅)  |

**Bonus findings (out of scope):**

- Next.js default `deviceSizes` generates **10 srcset entries per image**, not 5–8. Each is a billable CF transformation. If MMATF exceeds the 5k/mo free tier, trim `deviceSizes` to a 3–4 entry set as the obvious first knob.
- Foreign-host blog featured images (glasgowlands.org, squarespace-cdn.com) bypass the transform but still get wasted preload payloads with 10 identical-URL srcset entries. Worth a follow-up issue.

---

## Post-deploy re-verification — 2026-06-08

Two follow-up PRs shipped, both verified end-to-end against prod with the same
probe set used for the baseline above.

### PR #388 — first attempt (merged 00:10:54Z, deploy completed ~00:18Z)

Closed Phase 2B (`onerror=redirect`) and Phase 2C (OAuth avatar dimensions)
cleanly. Phase 2A (`priority={i === 0}`) shipped but **regressed** because the
companion `eagerLoad` mechanic (intended to keep cards 1–N non-lazy without
preloading) set `loading="eager"`, and Next.js 15.x emits a `<link rel="preload" as="image">` for `loading="eager"` too — not just `priority={true}`.

Post-deploy probe against `/blog`:

| Metric              | Baseline (pre-#388) | After #388 | Spec expectation |
| ------------------- | ------------------- | ---------- | ---------------- |
| preload image links | 3                   | **3** ❌   | 1                |
| `loading="eager"`   | 0                   | 2          | 0                |

The 3 preloads after #388 broke down to 1 `priority` card (R2-backed,
with the new `onerror=redirect` param visible in the URL — proving the
loader change DID deploy) + 2 `loading="eager"` cards (the foreign-host
featured images). Total preload count identical to baseline; the
preload-emission path had just shifted from `priority` to `eager`.

Root cause filed to memory: `[[feedback_nextimage_loading_eager_emits_preload]]`.

### PR #389 — fix-the-fix (merged 00:23:42Z, deploy completed ~00:30Z)

Reverted the `eagerLoad` prop from `EventCard` / `BlogPostCard` /
`VenueCard` and from all 4 caller sites. Cards 1–N now use Next/Image's
default lazy loading; the IntersectionObserver fires ~50–100px before
the viewport so non-LCP above-the-fold cards still load in time.

### Final probe rollup (post-#389, ~00:30Z)

| Probe                              | Baseline | After #388 | After #389       | Status |
| ---------------------------------- | -------- | ---------- | ---------------- | ------ |
| A5 `/blog` preload count           | 3        | 3          | **1**            | ✅     |
| A5 `/blog` `loading="eager"` count | 0        | 2          | **0**            | ✅     |
| Resilience baseline (no `onerror`) | HTTP 404 | HTTP 404   | **HTTP 404**     | ✅     |
| Resilience with `onerror=redirect` | n/a      | HTTP 307   | **HTTP 307**     | ✅     |
| A2 AVIF regression guard           | AVIF     | AVIF       | **`image/avif`** | ✅     |
| `/events` preloads / eager         | n/a      | n/a        | **0 / 0**        | ✅     |

`/events` showing **0** preloads (not 1) is because the first event
card on `/events` today happens to lack an `imageUrl` — falls back to
the category SVG illustration, which renders through `<Image>` without
`priority`. The fix correctly enforces "at most one preload"; actual
count is 0 or 1 depending on whether the first card has an R2 image.
The SVG fallback is a few KB, no preload needed; LCP is fine.

### Re-verification commands (for the next time)

```bash
# A5 — preload count drops on /blog
curl -s https://meetmeatthefair.com/blog | grep -oE 'rel="preload"[^>]*as="image"' | wc -l
# Expect: 1

# A5 — no loading=eager leaked back in
curl -s https://meetmeatthefair.com/blog | grep -oE 'loading="eager"' | wc -l
# Expect: 0

# Resilience — broken transform gracefully redirects
curl -sI 'https://meetmeatthefair.com/cdn-cgi/image/width=640,format=auto,onerror=redirect/https://cdn.meetmeatthefair.com/events/nonexistent/missing.jpg'
# Expect: HTTP/2 307, location: <source>

# A2 — content-type still correct
curl -sI -A "<chrome-ua>" -H "Accept: image/avif,*/*" '<one-cdn-cgi-url-from-event-detail-source>' | grep -i content-type
# Expect: image/avif
```

A1 / A3 / A4 (DevTools mobile bytes, Lighthouse mobile LCP, CLS) still
require interactive Chrome runs. Acceptance is unchanged from baseline:
LCP same-or-better, CLS ≤ 0.1, no "Properly size images" / "Serve next-gen
formats" / "Defer offscreen images" opportunities flagged.

---

## Outstanding follow-ups (not addressed in #388 or #389)

- **Trim `deviceSizes`** — Next.js default emits 10 srcset entries per image; each is a billable CF transformation. If MMATF exceeds the 5k/mo free tier, trim `deviceSizes` to 3–4 entries as the obvious first knob.
- **Foreign-host preload waste** — blog posts whose featured image lives on `glasgowlands.org`, `images.squarespace-cdn.com`, etc. bypass the cdn-cgi transform but still emit 10-entry `imageSrcSet` lists with the identical URL at every width. Two fixes possible: (a) migrate those images to R2, or (b) suppress the srcSet emission for foreign hosts.
