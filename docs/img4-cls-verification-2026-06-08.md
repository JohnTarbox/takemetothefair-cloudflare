# IMG4 — CLS verification report (2026-06-08)

**Filed:** 2026-06-08 against Dev-Email-2026-06-08 §E. **Status:** no code
change required pending operator-side Lighthouse confirmation.

## Background

Yesterday's IMG cluster closed IMG2 / IMG3 / IMG5 in PRs #394 + #397.
**IMG4 (zero CLS via explicit dimensions or reserved space) wasn't
directly called out in the dev's shipment notes.** Email §E asked for
verification before committing dev time — either it shipped implicitly
via aspect-ratio wrappers or didn't.

## Static analysis — every image audited

I walked every image-rendering surface across the highest-traffic
pages. Each row below is one `<img>` or `<Image>` callsite; the
"reserved space" column captures the mechanism (CLS metric goes to 0
when layout space is reserved BEFORE the image loads).

| Component / page                                         | Image element type       | Width × height on `<img>`/`<Image>` | Parent reserved-space mechanism                                                              | CLS risk |
| -------------------------------------------------------- | ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| `EventCard` hero — `event-card.tsx:183-196`              | raw `<img>`              | `width=800 height=450`              | `aspect-video relative` (16:9)                                                               | none     |
| `EventCard` hero (fallback) — `:203-212`                 | raw `<img>`              | `width=800 height=450`              | `aspect-video relative`                                                                      | none     |
| `EventCard` vendor logos — `:378-410`                    | `<Image fill>`           | n/a (fill)                          | `aspect-square` parent                                                                       | none     |
| `BlogPostCard` — `blog-post-card.tsx:89-101`             | raw `<img>`              | `width=800 height=450`              | `aspect-video relative bg-muted`                                                             | none     |
| `VenueCard` — `venue-card.tsx:111-123`                   | raw `<img>`              | `width=800 height=450`              | `aspect-video relative`                                                                      | none     |
| `VendorCard` logo — `vendor-card.tsx:95-106`             | raw `<img>`              | `width=64 height=64`                | `w-16 h-16` (64×64 px)                                                                       | none     |
| Event detail hero foreground — `[slug]/page.tsx:781-790` | raw `<img>`              | (no w/h on tag — `srcSet` only)     | `aspect-video relative` (16:9) — backdrop layer absolute-positioned so doesn't affect layout | none     |
| Event detail hero backdrop — `:768-776`                  | raw `<img>` (decorative) | (no w/h — `absolute inset-0`)       | absolute-positioned in `aspect-video` parent                                                 | none     |
| Event detail vendor logo — `:1013-1024`                  | `<Image fill>`           | n/a                                 | `w-10 h-10` (40×40) parent                                                                   | none     |
| Event detail promoter logo — `:1505-1516`                | `<Image fill>`           | n/a                                 | `w-12 h-12` (48×48) parent                                                                   | none     |
| `EventPopover` image — `event-popover.tsx:191-195`       | `<Image fill>`           | n/a                                 | `h-36 w-full` (144px tall, width 100%)                                                       | none     |

## Conclusion

**Static analysis shows zero CLS risk on every audited image surface.**
Every `<img>` and `<Image>` element either carries explicit `width`/
`height` attributes OR is mounted inside a parent that reserves layout
space via Tailwind's `aspect-video`, `aspect-square`, or explicit
`w-N h-N` dimensions. No image is mounted in a flow position where its
late-load could shift sibling content.

## Recommended next step (operator-side, no PR needed)

Run a Lighthouse mobile audit to confirm the metric matches the static
analysis:

1. Open Chrome DevTools → Lighthouse → Mobile → Performance → Analyze
   page load.
2. Capture screenshots of the CLS metric and the "Image elements do not
   have explicit width and height" finding (if any).
3. Repeat for:
   - Homepage (`/`)
   - One event detail page (`/events/<any-slug>`) with a hero image

### Possible outcomes

- **CLS ≈ 0 + no finding** → IMG4 satisfied implicitly. Close the row.
- **CLS ≈ 0 + cosmetic finding** → Lighthouse can be opinionated about
  parent-`aspect-video` patterns that don't put dimensions on the
  `<img>` itself; metric is the truth. Close with a note linking
  this report.
- **CLS > 0** → contradicts the static analysis; would mean Lighthouse
  found a layout shift on a surface this report missed. File a
  follow-up PR adding `width`/`height` to whichever element
  contributed. None expected.

## References

- `[[project_img1_smart_crop_hero.md]]` — event hero `aspect-video`
  wrapper + blurred-fill backdrop. Hero blur is screen-only and
  absolute-positioned, so it can't contribute to CLS.
- `[[feedback_nextimage_loading_eager_emits_preload]]` — adjacent
  lesson about Next.js `<Image>` preload semantics (not a CLS risk in
  itself but pinning for context).
- `[[cloudflare-images.md]]` (user-wide rules) — CLS rules
  §"CLS rules": every image MUST reserve its layout space before load,
  via explicit width/height OR a CSS `aspect-ratio` container, OR
  `next/image` with a sized container. **All three patterns confirmed
  in use across our surfaces.**
