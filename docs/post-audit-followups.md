# MMATF Post-Audit — Remaining Follow-Ups

Phases 1-13 of the April-17 UX/UI audit roadmap are live. This file captures what was deliberately left out and why, so future passes have the right context.

## Phase 13 deferred

**13.1 Map view on `/venues`** — requires adding Leaflet or Mapbox as a dependency and wiring lat/lng columns (already present on venues). Estimated 1-2 days. Separate release recommended so the map-library footprint is easy to measure.

**13.2 Vendor card upgrade** — the existing `VendorCard` already renders logo + name + city + products + upcoming-event count. Marginal additional polish vs. the bigger wins.

**13.3 Alphabetical jump bar on `/vendors`** — the directory is paginated at 50/page, so a per-page jump bar has limited value. A server-side first-letter filter (`?letter=W`) would be the right shape if users really need it; skip until there's evidence of the need.

**13.5 R2 image self-hosting** — event hero images that ship hotlinked from third-party CDNs (mainemade.com and similar) will break silently when those sites reshuffle. Proper fix: background job that copies og-images to R2 and rewrites `events.imageUrl`. Requires R2 bucket setup and a small Cron Trigger worker. Estimated 2-3 days including backfill.

**13.6 AVIF/WebP pipeline** — Cloudflare Images binding is available on this account. Wiring up image transforms on upload would reduce bandwidth materially. Estimated 1 day once the binding is configured.

## Phase 14 — Visual identity (contractor-dependent)

All items below require outside spend. Plan explicitly puts them last so in-house work can ship continuously.

- **Category illustrations** — 12 linocut/block-print style illustrations from a single illustrator, three-color palette drawn from `amber`/`terracotta`/`navy`. Budget estimate: $1,500-$4,000 from Are.na/Dribbble junior, $8-15k for mid-career. Drops into `getCategoryImage()` in `src/lib/category-colors.ts`.

- **Typographic fallback cards** for events without illustrations (audit §5B). This is a cheap in-house alternative that might obviate the illustration commission entirely — worth piloting first. Plain CSS: category name + state initials on a tinted card.

- **Hero redesign** — warm cream background with subtle paper grain, left-column display serif H1 cluster, right-column hero illustration or cropped linocut landscape. Depends on illustrations landing first.

- **Wordmark refinement** — minimum viable is a ticket-stub brand bug that works as a 32px avatar. Logo designer, 1-day project.

- **Footer decorative band** — scalloped edge, ticket-stub perforation, or illustrated bunting line above the footer contents. CSS + one SVG asset.

- **Sticky header with background blur on scroll** — in-house; deferred only because it's more impactful once the typographic identity lands.

- **Subtle grain/paper texture on hero + CTA panels + empty states** — single PNG at 1-2% opacity, applied globally.

## Shipped at a glance

| Phase | Theme                                                             | Commit                 |
| ----- | ----------------------------------------------------------------- | ---------------------- |
| 1     | Week-1 foundations (fonts, pagination, gold CTA, focus styles)    | b749c37                |
| —     | Category chip palette remap                                       | efcee71                |
| 2     | Trust & recovery (forgot pw, email verify, role pill, author fix) | 372888a + 2 follow-ups |
| 3     | URL import confidence pills + venue preview                       | 9d0fc39                |
| 4     | Onboarding checklists + welcome banners + empty states            | f0a92a2                |
| 5     | Vendor apply conversion + filter tabs + withdraw                  | 40ee1e5                |
| 6     | Promoter event wizard + drafts + duplicate + vendor counts        | 1340ebc                |
| 7     | Form UX primitives — field errors, autosave, error summary        | 049137f                |
| 8     | Mobile filter drawer + sticky apply bar                           | 09a8e72                |
| 9     | Blog link checker (script + per-save warnings)                    | e721b03                |
| 10    | TOC, tag landing pages, sitemap tag entries                       | 858690a                |
| 11    | Homepage weekend module + real counts + newsletter + testimonials | 02a688c                |
| 12    | Retire royal hovers + Badge info to stone                         | e392e5c                |
| 13    | Filter sidebar visual weight + amber filter pills                 | (this phase)           |
