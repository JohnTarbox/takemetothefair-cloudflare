# Meet Me at the Fair - Cloudflare Pages Version

A community calendar website for fairs and events, built for deployment on Cloudflare Pages with D1 database.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **ORM**: Drizzle ORM
- **Authentication**: NextAuth.js with edge-compatible config
- **Styling**: Tailwind CSS
- **Deployment**: Cloudflare Pages

## Migration Status

This is a work-in-progress migration from the original Prisma/SQLite version. The following has been completed:

- [x] Drizzle schema and configuration
- [x] Cloudflare D1 setup (wrangler.toml)
- [x] Edge-compatible auth (SHA-256 password hashing)
- [x] Database helper utilities
- [x] Homepage migrated to Drizzle
- [x] Seed script for local development

**TODO**: The remaining pages and API routes still reference Prisma and need to be migrated to use Drizzle queries. Follow the pattern in `src/app/page.tsx` for migration.

## Getting Started

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account (for deployment)

### Local Development

```bash
# Install dependencies
npm install

# Create D1 database locally
wrangler d1 create takemetothefair-db --local

# Generate Drizzle migrations
npm run db:generate

# Apply migrations
npm run db:migrate

# Seed the database
npm run db:seed

# Start development server
npm run dev
```

### Test Accounts

After seeding:
- **Admin**: admin@takemetothefair.com / admin123
- **Promoter**: promoter@example.com / promoter123
- **Vendor**: vendor@example.com / vendor123

## Deployment to Cloudflare Pages

```bash
# Login to Cloudflare
wrangler login

# Create D1 database (production)
wrangler d1 create takemetothefair-db

# Update wrangler.toml with the database_id from the output

# Apply migrations to production
npm run db:migrate:prod

# Build and deploy
npm run pages:deploy
```

## Project Structure

```
├── src/
│   ├── app/           # Next.js pages
│   ├── components/    # React components
│   ├── lib/
│   │   ├── db/        # Drizzle schema and helpers
│   │   ├── auth.ts    # NextAuth configuration
│   │   └── cloudflare.ts  # D1 binding helpers
│   └── types/         # TypeScript types
├── scripts/
│   └── seed.ts        # Database seed script
├── drizzle/           # Generated migrations
├── wrangler.toml      # Cloudflare configuration
└── drizzle.config.ts  # Drizzle configuration
```

## Key Differences from Original Version

| Feature | Original | Cloudflare |
|---------|----------|------------|
| Database | SQLite file | Cloudflare D1 |
| ORM | Prisma | Drizzle |
| Password Hashing | bcrypt | SHA-256 (edge-compatible) |
| Runtime | Node.js | Edge |

## Migration Guide

To migrate a page from Prisma to Drizzle:

1. Add `export const runtime = "edge";` at the top
2. Replace `import prisma from "@/lib/prisma"` with:
   ```typescript
   import { getCloudflareDb } from "@/lib/cloudflare";
   import { tableName } from "@/lib/db/schema";
   import { eq, and, gte } from "drizzle-orm";
   ```
3. Replace Prisma queries with Drizzle queries:
   ```typescript
   // Prisma
   const items = await prisma.event.findMany({ where: { status: "APPROVED" } });

   // Drizzle
   const db = getCloudflareDb();
   const items = await db.select().from(events).where(eq(events.status, "APPROVED"));
   ```

## License

MIT
