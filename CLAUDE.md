# CLAUDE.md

> **This is the PRIMARY codebase.** Always work here (`takemetothefair-cloudflare`), not in the legacy Prisma-based `takemetothefair` directory.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Auto-load Skills

Always load these skills when working on this project:

- `/cloudflare-d1` - D1 database patterns, migrations, error handling
- `/drizzle-orm-d1` - Drizzle ORM with D1, schema definitions, queries
- `/nextjs` - Next.js App Router, Server Components, caching

## Cloudflare MCP Server

This project has the Cloudflare MCP server configured (`.mcp.json`). Use `search()` to discover API endpoints and `execute()` to call them.

### Resource IDs (for MCP queries)

- **Account**: Use `search("list accounts")` to discover
- **D1 Database**: `d449e416-3814-48a6-b9e8-b676333b2cdc` (name: `takemetothefair-db`)
- **KV Namespace**: `b7aeca316e7a41108fd375be2e152cff` (binding: `RATE_LIMIT_KV`)
- **R2 Bucket**: `mmatf-vendor-assets` (binding: `VENDOR_ASSETS`, served at `cdn.meetmeatthefair.com`)
- **Pages Project**: `takemetothefair`
- **Domain**: `meetmeatthefair.com`
- **AI Model**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (single source of truth: `WORKERS_AI_MODEL` in `@takemetothefair/constants`; the prior `@cf/meta/llama-3.1-8b-instruct` was deprecated + error-5028'd 2026-06-15, swapped in K28)

## Cloudflare Account

**This project uses the `jtarboxme@gmail.com` Cloudflare account ONLY.**

- Account Name: `John Tarbox - Account`
- Account ID: `e6011e48b7014ef83c77e3c767dac6cf`
- **Never use the APRS Foundation account** (`john.tarbox@aprsfoundation.org`)
- Before any wrangler command that touches Cloudflare (deploy, d1 migrations, etc.), verify with `npx wrangler whoami`

### Safety Rules

- Prefer `SELECT` queries over mutations when inspecting D1 data
- Never run `DELETE`, `DROP`, or destructive DNS changes without explicit user confirmation
- Always confirm before write operations that affect production resources
- `execute()` is not pre-approved — each call prompts for confirmation

## Runtime & Worker Topology

The site runs as **two separate deploy artifacts on the `meetmeatthefair.com` zone**. They never share a route — they live on different hostnames. Get this wrong and you'll mis-plan migrations or chase phantom route collisions.

| Artifact       | Hostname                     | What it is                                                                                                                                                                                                          | Routing                                                                                                                                                           |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Main app**   | `meetmeatthefair.com` (apex) | Next.js via `@cloudflare/next-on-pages`, deployed to the Pages project `takemetothefair`. Serves every page/API route **including all `sitemap*.xml`** (Next.js route handlers in `src/app/sitemap*.xml/route.ts`). | Pages-native routing. No `[[routes]]` block in `wrangler.toml`.                                                                                                   |
| **MCP Worker** | `mcp.meetmeatthefair.com`    | `meetmeatthefair-mcp` Worker (source in `mcp-server/`). MCP API + inbound/outbound email + Workflows + crons.                                                                                                       | `[[routes]] pattern = "mcp.meetmeatthefair.com"`, `custom_domain = true` in `mcp-server/wrangler.toml`. **A separate hostname, NOT a wildcard path on the apex.** |

**Cross-artifact contract (these are easy to miss):**

- The main app is a **Queue producer** for `EMAIL_JOBS` and `INDEXNOW_PINGS` (`wrangler.toml`); the **MCP Worker is the consumer**. Producer queue names must match the consumer's exactly or messages drop silently (no email, no IndexNow ping).
- All **Workflows** (`inbound-email`, `recommendations-scan`, `event-date-drift`, `schema-org-sync`) and all **cron**-like work live in the MCP Worker, because **Pages cannot bind Workflows** (Cloudflare rejects `[[workflows]]` in a Pages `wrangler.toml` at config-validation — this caused a 30-min deploy lock-up once). The main app has **no cron triggers**.
- The main app reaches the MCP Worker over **HTTP + `INTERNAL_API_KEY`**, not a Service Binding.

**Historical note — sitemap hotfix Worker (no longer in the serving path):** During the 2026-04-25 sitemap incident, a one-off Worker was deployed with a **trailing-wildcard apex route** (`meetmeatthefair.com/sitemap.xml*`) to override the Pages Function — a wildcard Worker route beats a Pages Function for the same path on Cloudflare's tiebreak, where an exact-match route loses. That Worker is no longer serving (the sitemap is back on Next.js; verify with `curl -sI https://meetmeatthefair.com/sitemap.xml` → `x-matched-path: /sitemap.xml` present, no `X-Sitemap-Source` header). The wildcard-vs-Pages precedence behavior itself is real and reproducible — keep it in mind for incident hotfixes, and **list zone Worker routes as a pre-flight** before any Pages→Workers migration to confirm no dangling apex route contends with the cutover.

## Build & Development Commands

```bash
# Development
npm run dev                    # Start Next.js dev server

# Build & Deploy
npm run build                  # Next.js build (local testing)
npx @cloudflare/next-on-pages  # Build for Cloudflare Pages
npx wrangler pages deploy .vercel/output/static --project-name=takemetothefair --commit-dirty=true

# Database
npm run db:generate            # Generate Drizzle migrations
npm run db:migrate             # Apply migrations locally
npm run db:migrate:prod        # Apply migrations to production
npm run db:seed                # Seed local database
npm run db:studio              # Open Drizzle Studio
```

## Critical: Cloudflare Edge Runtime

**Every page and API route MUST include:**

```typescript
export const runtime = "edge";
```

This project runs on Cloudflare Pages with D1 (SQLite at edge). Node.js APIs are not available.

## Database Access Pattern

```typescript
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { eq, and, gte } from "drizzle-orm";

export const runtime = "edge";

async function getData() {
  const db = getCloudflareDb();
  const results = await db
    .select()
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(eq(events.status, "APPROVED"), gte(events.endDate, new Date())));
  return results;
}
```

## Architecture Overview

### User Roles & Portals

- **Public**: Browse events, venues, vendors (`/events`, `/venues`, `/vendors`)
- **User**: Dashboard with favorites (`/dashboard`)
- **Vendor**: Profile management, event applications (`/vendor/*`)
- **Promoter**: Create/manage events (`/promoter/*`)
- **Admin**: Full management (`/admin/*`)

### Core Data Model

- **Events**: Central entity with promoter (required), venue (optional), and many-to-many vendors
- **Promoters**: Organizations that create events (linked to user account)
- **Vendors**: Businesses that apply to participate in events (linked to user account)
- **Venues**: Physical locations where events occur
- **userFavorites**: Polymorphic favorites (EVENT, VENUE, VENDOR, PROMOTER)

### Key Patterns

**JSON Arrays in SQLite**: Categories, tags, amenities, products stored as JSON strings

```typescript
import { parseJsonArray } from "@/types";
const categories = parseJsonArray(event.categories); // Returns string[]
```

**Page Caching (ISR)**:

```typescript
export const revalidate = 300; // Cache for 5 minutes
```

**Authentication**:

```typescript
import { auth } from "@/lib/auth";
const session = await auth();
if (session?.user?.role === "ADMIN") { ... }
```

### Blog FAQ schema (FAQPage emission)

Blog posts emit Schema.org `FAQPage` JSON-LD from exactly one of two sources, chosen at render time in `src/app/blog/[slug]/page.tsx`:

1. **Tier 1 (wins): `blog_posts.faqs` JSON column.** Emitted when the column parses to an array of ≥ `FAQ_MIN_ITEMS` (=3) valid `{question, answer}` pairs. Populated via MCP `create_blog_post` / `update_blog_post` (`faqs:` arg) or the admin API. Pass `faqs: []` via `update_blog_post` to clear and revert to Tier 2.
2. **Tier 2 (fallback): `## Q: …` H2 headings in the body markdown.** `extractBlogFaqItems(post.body)` parses each `## Q: <question>` heading and pairs it with the prose up to the next H1/H2. Emitted when ≥3 pairs are found. H3 sub-questions are intentionally ignored.

Posts with neither emit no FAQ schema (`<FAQPageSchema items={[]} />` renders `null`).

The two sources **never combine and never conflict**: one wins per render, or neither meets the threshold and nothing is emitted. Hand-editing a body that already has a populated `faqs` column does NOT change the emitted schema — to change it, edit `faqs` via MCP.

Visibility from MCP: `get_blog_post` and `list_blog_posts` return a computed `faq_source` field with one of `"column"`, `"markdown"`, or `"none"`, so drift after an edit is visible without loading the public page. The classifier lives in `packages/utils/src/blog-faq-source.ts`.

### Event Scrapers

Located in `src/lib/scrapers/`. Import events from external fair websites (mainefairs.net, etc.). Used via admin import page (`/admin/import`).

### URL Import Feature (CRITICAL)

**This is one of the most important features on the website.** Located at `/admin/import-url`, it allows importing events from arbitrary URLs using AI-powered extraction.

**Priority**: Must be capable, flexible, and resilient. When making changes:

- Test with diverse URL sources (event pages, venue sites, social media)
- Handle edge cases gracefully (missing data, unusual date formats, no structured data)
- Always provide manual fallback options for users
- Maintain robust error handling with helpful user messages

**Architecture** (`src/lib/url-import/`):

- `types.ts` - TypeScript interfaces for extracted data
- `html-parser.ts` - Extracts text content and metadata (title, og:image, JSON-LD)
- `ai-extractor.ts` - Cloudflare Workers AI (Llama 3.1 8B) extraction with fallbacks

**API Routes** (`src/app/api/admin/import-url/`):

- `fetch/route.ts` - GET: Fetches URL, extracts text and metadata
- `extract/route.ts` - POST: AI extraction from content
- `route.ts` - POST: Saves event with venue creation

**Key Design Decisions**:

1. Uses Workers AI (no external API keys needed)
2. Hybrid approach: AI suggests, user verifies/corrects
3. Manual paste fallback if fetch fails
4. JSON-LD structured data used when available for higher accuracy
5. Date parsing handles multiple formats (ISO, "February 01, 2026", "1/15/25", etc.)

## Dedup, merge, and provenance (K-bundle, 2026-05-31)

Three coupled surfaces — shipped as PRs #280–#287 in May 2026 (drizzle/0094, 0095, 0096). When working in this area, know the data model BEFORE editing.

### Dedup match key — `findDuplicate()`

Source of truth: `src/lib/duplicates/find-duplicate.ts`. The 4-stage matcher used by the `/api/suggest-event/check-duplicate` route (and intended for the email pipeline's enrich-or-flag step once Part 5's behavior wiring lands):

1. `exact_url` — `events.source_url` equality (short-circuit)
2. `venue_date` — `autoLinkVenue` resolves a venueId; events at that venue within ±7d
3. `city_state_date` — `events INNER JOIN venues` on city+state; ±7d (catches the Winthrop-shape case where two venue rows describe the same place)
4. `similar_name_date` — Levenshtein > 0.85 on `normalizeName(name)` (legacy tiebreaker)

`normalizeName()` lives in `src/lib/duplicates/normalize-name.ts` and strips leading ordinals (`38th `, `Annual `), trailing year (` 2026`), and punctuation.

**Two existing MCP tools — `suggest_event` (vendor.ts:772-788) and `update_event` (admin.ts:861-911) — still use a different overlap-based dedup**. Rewiring them through `findDuplicate` is deferred per #285's commit message — they surface `warnings.possible_duplicates` rather than blocking, so the behavior change needs its own audit.

### Merge — `merge_events` MCP tool + `mergeEvents()` core

When two events are confirmed to be the same, `merge_events(keeper_event_id, duplicate_event_id)` (in `mcp-server/src/tools/admin-event-lifecycle.ts`, calling `/api/admin/duplicates/merge` over `X-Internal-Key`) preserves SEO equity:

1. **Renames** the duplicate's slug to `<orig>-merged-<id8>` so the URL is free
2. **Writes `event_slug_history`** (`oldSlug=<original-dup>, newSlug=<keeper>, eventId=keeperId`). Middleware (`src/middleware.ts:204-217`) walks this chain → 301 redirect from old slug to keeper.
3. **Marks duplicate `status='REJECTED'`, `merged_into=keeperId`** — row stays as audit tombstone
4. **Transfers FK children**: `event_vendors`, `event_days`, `event_data_citations`, `content_links` (target_type='EVENT'), `user_favorites`; `view_count` adds. Source-\* fields (`source_url`, `source_domain`, `source_id`, `source_name`) gap-fill from dup → keeper when keeper has NULL.
5. **Writes `admin_actions(action='event.merge')`**

Refuses if the duplicate is already merged (`merged_into IS NOT NULL`) or if ids are equal.

### Provenance — `event_data_citations`

Citations table tracks "source X said field Y = Z" for events. Updated 2026-05-31 to cover the structural fields too — `start_date`, `end_date`, `venue_id`, `name` in addition to the numeric `estimated_attendance` / fee / ticket-price / `application_deadline`. The denorm map at `mcp-server/src/tools/admin-citations.ts:36` is the allow-list.

`update_event` accepts an optional `citation: { source_url, source_type, ... }` arg; when present and a tracked field changes, one citation row is auto-inserted per touched field, auto-superseding any prior `active` citation for the same `(event, field, year)` bucket.

### Sweep canary — `/api/admin/duplicates/sweep`

Daily-pollable endpoint (`src/app/api/admin/duplicates/sweep/route.ts`) returns APPROVED-event clusters that share `(venue_id, start_date)` or `(venues.city, venues.state, events.start_date)`. Subset-filtered server-side. **Doesn't auto-merge** — surfaces candidates for operator triage via `merge_events`. Cron canary for Slack alerts on growth is deferred per #287's commit.

### Extractor robustness — deterministic salvage

When `/api/admin/import-url/extract` calls Workers AI and gets zero events back, it falls through to a deterministic composer (`src/lib/url-import/deterministic/compose.ts`) that lifts name + date + venue from:

- Add-to-calendar URL params (Google Calendar TEMPLATE, Outlook deeplink) — `calendar-link.ts`
- Month-day-range regex over cleaned text (`JUNE 19-20, 2026`) — `date-regex.ts`
- OG title / h1 / h2 / URL-slug — `og-name.ts`

Gate: `name + (date OR venue)`. On pass, returns `extractionMethod: "thin"` which flips `inbound_emails.flagged_for_review=1` at the workflow's `mark-done` step. Telemetry columns `extract_fail_reason`, `content_sha256_first16`, `content_length_chars` on `inbound_emails` are populated by the workflow's `submit/persist-extract-context` step (after fetch, before AI extract).

### Key column semantics

| Column                               | Where        | Meaning                                                                                                                                                                                     |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.merged_into`                 | drizzle/0095 | Set by `merge_events`. Row is a tombstone — its slug redirects to the keeper via slug-history.                                                                                              |
| `events.possible_duplicate_of`       | drizzle/0096 | **Behavior wiring deferred (#286).** Intended for MEDIUM-confidence dedup matches from the email pipeline — flags PENDING for operator review. Today the column exists but nothing sets it. |
| `inbound_emails.flagged_for_review`  | pre-existing | Now also set when `extractionMethod='thin'` (deterministic salvage).                                                                                                                        |
| `inbound_emails.extract_fail_reason` | drizzle/0094 | Categorical: `zero-events` / `thin-content` / `parse-error` / `ai-timeout` / `other`. Set in the AI-extract catch.                                                                          |

### Session-state gotchas

- The MCP tool registry I see is frozen from session-start. After deploying a new MCP tool (like `merge_events`), it isn't in the `mcp__claude_ai_*` namespace until the next session. Mid-session, call it via direct curl using the `mmatf_` admin token (see `[[reference_admin_mcp_token]]`).
- Prod D1 reads via `wrangler d1 execute --remote` are blocked by the auto-mode classifier even for SELECT. Use the Cloudflare Developer Platform MCP server's `d1_database_query` tool instead (see `[[feedback_prod_d1_blocked_via_wrangler]]`).

## Test Accounts (after seeding)

- Admin: admin@takemetothefair.com / admin123
- Promoter: promoter@example.com / promoter123
- Vendor: vendor@example.com / vendor123

## Common Pitfalls & Solutions

### Absolute positioned elements over images

When placing buttons/icons over images using `absolute` positioning, add `z-10` or higher to ensure visibility:

```tsx
<div className="relative">
  <Image src={...} fill className="object-cover" />
  <button className="absolute top-3 right-3 z-10">...</button>
</div>
```

### Client component click handlers

Interactive buttons in client components need proper event handling to work reliably:

```tsx
<Button
  type="button"  // Prevents form submission behavior
  onClick={(e) => {
    e.preventDefault();
    e.stopPropagation();
    // handler logic
  }}
>
```

### N+1 Query Prevention

Avoid fetching related data in loops. Use single queries with JOINs or batch fetch with `inArray`:

```typescript
// Bad: N+1 queries
for (const event of events) {
  const vendors = await db.select().from(eventVendors).where(eq(eventVendors.eventId, event.id));
}

// Good: Single batch query
const eventIds = events.map((e) => e.id);
const allVendors = await db
  .select()
  .from(eventVendors)
  .where(inArray(eventVendors.eventId, eventIds));
const vendorsByEvent = new Map(); // Group in memory
```

### Next.js Image component with fill

When using `fill` prop, the parent must have `relative` positioning and explicit dimensions:

```tsx
<div className="aspect-video relative">
  <Image src={url} alt={alt} fill sizes="(max-width: 768px) 100vw, 50vw" className="object-cover" />
</div>
```

### Slug typing and the canonical generator (#120 prevention)

All stored slugs (events, venues, vendors, promoters, blog posts, slug history) must come from `createSlug()` from `@takemetothefair/utils`. Three layers of defense are in place after the May 2026 slug-divergence bug (#120):

1. **Typed producers**: `createSlug()` and `createSlugFromName()` return the branded `Slug` type. Hand-rolled regex chains produce plain `string`.
2. **Typed storage**: schema columns (`events.slug` etc.) accept only `Slug` via Drizzle's `.$type<Slug>()`. Writing a raw string is a TypeScript error.
3. **Banned regex**: ESLint's `no-restricted-syntax` rule rejects `/[^a-z0-9]+/` regex literals outside the canonical helper. Catches the `unsafeSlug(naiveChain(x))` loophole.

When you genuinely need to pass a string into a slug column from a boundary (URL params, JSON request bodies, D1 SELECT results pre-migration), use the explicit cast: `unsafeSlug(s)`. Searchable in code review.

```ts
// Good:
const slug = createSlug(name);                  // Slug
db.insert(events).values({ slug });              // ok

// Boundary cast (URL param):
const { slug } = await params;
.where(eq(events.slug, unsafeSlug(slug)))        // ok, explicit

// Suffix append preserving brand:
const candidate = appendSlugSegment(baseSlug, suffix);  // Slug

// Bad — TypeScript error:
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");  // string
db.insert(events).values({ slug });              // TS error
// AND the regex literal would fail lint anyway.
```

Why the `slugify`-backed `createSlug` matters: it expands `&` to `"and"`, drops apostrophes cleanly, transliterates accented chars. The naive regex doesn't, which silently produced duplicate venues in production until the three-layer defense was put in place.

### Free-text input decoding at the schema boundary

User-facing string fields (names, descriptions, titles, business names) must use `.transform(decodeHtmlEntities)` at the Zod schema layer so dedup matching, slug generation, and storage all see literal characters by construction. Prevents silent failures when callers send entity-encoded text (e.g. agents posting `Earth Expo &amp; Convention Center`, which would otherwise miss dedup against the existing `Earth Expo & Convention Center` row and create a duplicate).

- **Main app**: shared `nameSchema` / `descriptionSchema` in `src/lib/validations/index.ts` already apply the transform — endpoints using them inherit decoding automatically. Helper at `src/lib/utils.ts:decodeHtmlEntities`.
- **MCP server**: helper at `mcp-server/src/helpers.ts:decodeHtmlEntities`. Apply per-field on every new tool that takes free-text strings.
- **Skip**: URLs (URL-encoded `&` is meaningful in query strings), email/phone/ZIP/state codes, enum values, FK ids.

Order matters in the chain: put `.min()`/`.max()` BEFORE `.transform()` so length validators run on raw input (decoding only ever shortens, so the raw cap is a safe upper bound):

```ts
title: z.string().min(1).max(200).transform(decodeHtmlEntities).optional();
```
