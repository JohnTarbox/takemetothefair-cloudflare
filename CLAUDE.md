# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Auto-load Skills

Always load these skills when working on this project:
- `/cloudflare-d1` - D1 database patterns, migrations, error handling

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

### Event Scrapers
Located in `src/lib/scrapers/`. Import events from external fair websites (mainefairs.net, etc.). Used via admin import page (`/admin/import`).

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
const eventIds = events.map(e => e.id);
const allVendors = await db.select().from(eventVendors).where(inArray(eventVendors.eventId, eventIds));
const vendorsByEvent = new Map(); // Group in memory
```

### Next.js Image component with fill
When using `fill` prop, the parent must have `relative` positioning and explicit dimensions:
```tsx
<div className="aspect-video relative">
  <Image src={url} alt={alt} fill sizes="(max-width: 768px) 100vw, 50vw" className="object-cover" />
</div>
```
