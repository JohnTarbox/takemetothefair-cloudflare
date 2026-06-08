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

| Spec criterion                  | Status                                                | Action                        |
| ------------------------------- | ----------------------------------------------------- | ----------------------------- |
| A1 — phone-sized bytes          | Pending DevTools run                                  | Manual re-verify after deploy |
| A2 — AVIF/WebP per UA           | ✅ PASS                                               | None                          |
| A3 — Lighthouse LCP             | Pending Lighthouse run                                | Manual re-verify after deploy |
| A4 — CLS ≈ 0                    | Pending; Phase 2C closes the 2 OAuth-avatar exposures | Phase 2C                      |
| A5 — one preload/page           | ⚠️ FAIL on `/blog` (3 preloads)                       | Phase 2A                      |
| Resilience — `onerror=redirect` | ⚠️ MISSING                                            | Phase 2B                      |

**Bonus findings (out of scope):**

- Next.js default `deviceSizes` generates **10 srcset entries per image**, not 5–8. Each is a billable CF transformation. If MMATF exceeds the 5k/mo free tier, trim `deviceSizes` to a 3–4 entry set as the obvious first knob.
- Foreign-host blog featured images (glasgowlands.org, squarespace-cdn.com) bypass the transform but still get wasted preload payloads with 10 identical-URL srcset entries. Worth a follow-up issue.

---

## After-state re-verification (run after Phase 2 deploys)

Re-run A2, A5, and the resilience baseline:

```bash
# A2 — content-type still correct
curl -sI -A "<chrome-ua>" '<one-cdn-cgi-url-from-event-detail-source>' | grep content-type
# Expect: image/avif

# A5 — preload count drops on /blog
curl -s https://meetmeatthefair.com/blog | grep -oE 'rel="preload"[^>]*as="image"' | wc -l
# Expect: 1 (was: 3)

# Resilience — broken transform now gracefully redirects
curl -sI 'https://meetmeatthefair.com/cdn-cgi/image/width=640,format=auto/https://cdn.meetmeatthefair.com/events/nonexistent/missing.jpg'
# Expect: 307 redirect (was: 404)
```

Also run Lighthouse mobile for A3/A4 on the 3 listing pages + 2 detail pages
and confirm LCP same-or-better and CLS ≤ 0.1 each.
