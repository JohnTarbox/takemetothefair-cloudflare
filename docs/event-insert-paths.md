# The 5 event-insert paths (WS2a, 2026-06-11)

Five routes `db.insert(events)`. They share mechanical scaffolding but diverge on
**policy** — and that divergence is intentional. This documents the divergence
matrix so the shared helpers (`src/lib/events/insert-helpers.ts`) stay scoped to
the genuinely-identical mechanics and the policy stays in each caller.

| Path | File |
| --- | --- |
| admin create | `src/app/api/admin/events/route.ts` (POST) |
| URL import | `src/app/api/admin/import-url/route.ts` (POST) |
| promoter create | `src/app/api/promoter/events/route.ts` (POST) |
| promoter draft | `src/app/api/promoter/events/draft/route.ts` (POST) |
| community submit | `src/app/api/suggest-event/submit/route.ts` (POST) |

## Policy divergences (why a single `createEventCore` would be a leaky abstraction)

| Dimension | admin | import | promoter | draft | submit |
| --- | --- | --- | --- | --- | --- |
| **Status** | caller `status`, gate→PENDING | always APPROVED (gate→PENDING) | hardcoded PENDING | DRAFT or PENDING (submit flag) | TENTATIVE(vendor)/PENDING, gate→PENDING |
| **Gates** (`evaluateGates`) | yes | yes | no | no | yes (+ past-date guard) |
| **Venue** | caller venueId | create/link + geocode | caller venueId | caller venueId | `autoLinkVenue` fuzzy |
| **Categories** | passthrough | infer-from-name fallback | passthrough | passthrough | infer-from-name fallback |
| **Source fields** | yes | yes | no | no | yes (+ suggesterEmail, submittedBy) |
| **lifecycleStatus / possibleDuplicateOf** | no | no | no | no | yes |
| **IndexNow ping** | if public | event + new venue | no | no | if public |
| **flaggedForReview on missing hours** | no | yes | no | no | yes |

A unifying core would need ~8 policy flags — it would relocate the 5 behaviors
behind a switchboard, not unify them, and a wrong default would silently change
the core write path. So policy stays in the callers.

## What WAS extracted (the genuinely-shared mechanics)

`src/lib/events/insert-helpers.ts`:

- **`insertEventDaysBatched(db, eventId, days)`** — D1-safe batched `event_days`
  insert (chunks of 11). Replaced 5 near-identical copies. **Fixed a latent bug**:
  `promoter/events` and `promoter/events/draft` inserted ALL days in one
  statement, blowing D1's bound-parameter limit for events with ≥12 days; they
  now chunk like the other three.
- **`resolveUniqueEventSlug(db, baseSlug)`** — single prefix-range query +
  `findUniqueSlug`. Replaced 5 copies in 2 variants. The two former while-loop
  paths (import, submit) now produce `base-2` first on a name collision instead
  of `base-1` (findUniqueSlug skips `-1`) — a cosmetic suffix change on the rare
  collision case, no effect on existing URLs. Callers keep their own
  `createSlug` + empty-slug handling.

`assembleCommonEventFields` was considered but **not** built: each path's
`.values()` sets a different column subset with per-path-computed values, so a
"common fields" helper would cover only ~10 truly-identical fields while each
caller still spreads + extends — net indirection with little dedup. The two
mechanical helpers capture the real duplication + the bug fix.

## Reusable helpers each path already composes

`createSlug`, `findUniqueSlug`/`getSlugPrefixBounds` (now via
`resolveUniqueEventSlug`), `computePublicDates`, `dollarsToCents`,
`normalizeEventDate`, `evaluateGates`, `classifySource`,
`inferCategoriesFromName`, `autoLinkVenue`, `recomputeEventCompleteness`,
`pingIndexNow`/`indexNowUrlFor`.
