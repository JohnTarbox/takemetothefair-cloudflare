# Project: Meet Me at the Fair (Cloudflare)

## Build Target
**This project deploys to Cloudflare Pages with D1 database.** Always use:
- `export const runtime = "edge";` in all page and API route files
- Drizzle ORM (not Prisma) for database operations
- `getCloudflareDb()` from `@/lib/cloudflare` for database access
- `npx @cloudflare/next-on-pages` to build
- `npx wrangler pages deploy .vercel/output/static --project-name=takemetothefair` to deploy

## Tech Stack
- Next.js 14 (App Router)
- Cloudflare Pages + D1 (SQLite)
- Drizzle ORM
- NextAuth.js for authentication
- Tailwind CSS
- TypeScript

## Key Directories
- `src/lib/db/schema.ts` - Drizzle schema definitions
- `src/lib/cloudflare.ts` - Cloudflare D1 database helper
- `src/app/api/` - API routes (all need `export const runtime = "edge"`)
- `src/app/admin/` - Admin pages

## Database Access Pattern
```typescript
import { getCloudflareDb } from "@/lib/cloudflare";

export const runtime = "edge";

export async function GET() {
  const db = getCloudflareDb();
  const results = await db.select().from(tableName);
  // ...
}
```

## Deployment Commands
```bash
# Build for Cloudflare
npx @cloudflare/next-on-pages

# Deploy to Cloudflare Pages
npx wrangler pages deploy .vercel/output/static --project-name=takemetothefair --commit-dirty=true
```
