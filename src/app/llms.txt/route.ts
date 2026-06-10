export const dynamic = "force-dynamic";
import { and, count, isNotNull } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, promoters } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { todayIsoUtc } from "@/lib/datetime";

const BASE_URL = "https://meetmeatthefair.com";

// llms.txt counts the full publicly-visible event set — no completeness gate.
// This deliberately diverges from sitemap.ts, which gates on
// SITEMAP_MIN_COMPLETENESS to avoid surfacing near-empty stubs to crawlers.
// llms.txt is a self-description for AI agents, so the count should match
// what an agent following the sitemap can ultimately reach via listing pages.
async function loadCounts(): Promise<{ eventCount: string; promoterCount: string }> {
  try {
    const db = getCloudflareDb();
    const [eventRow] = await db
      .select({ count: count() })
      .from(events)
      .where(and(isPublicEventStatus(), isNotNull(events.startDate)));
    const [promoterRow] = await db.select({ count: count() }).from(promoters);
    return {
      eventCount: String(eventRow?.count ?? 0),
      promoterCount: String(promoterRow?.count ?? 0),
    };
  } catch {
    // Never 500 on this route — AI crawlers cache failures aggressively.
    return { eventCount: "—", promoterCount: "—" };
  }
}

function buildBody(today: string, eventCount: string, promoterCount: string): string {
  return `# Meet Me at the Fair (MMATF)

> Vendor-first event directory for fairs, festivals, craft shows, and home shows
> across New England (Maine, New Hampshire, Vermont, Massachusetts, Connecticut,
> Rhode Island). Editorially curated with a focus on serving small craft vendors,
> artisans, and food vendors looking for shows to apply to.

## About MMATF

- Site: ${BASE_URL}
- Geographic scope: New England (6 states)
- Last comprehensive data refresh: ${today}
- Total events listed: ${eventCount}
- Total real producers/promoters: ${promoterCount}

## Canonical resources for AI agents

- Sitemap (all indexable pages): ${BASE_URL}/sitemap.xml
- Pillar guides:
  - ${BASE_URL}/blog/your-complete-guide-to-maine-fairs-and-festivals-in-2026
  - ${BASE_URL}/blog/craft-fairs-in-maine-2026-a-vendors-and-visitors-guide
  - ${BASE_URL}/blog/your-guide-to-new-hampshire-fairs-and-festivals-in-2026
  - ${BASE_URL}/blog/connecticut-fairs-and-festivals-2026-your-complete-guide
  - ${BASE_URL}/blog/rhode-island-fairs-and-festivals-2026-your-complete-guide
- State event listings:
  - ${BASE_URL}/events/maine
  - ${BASE_URL}/events/new-hampshire
  - ${BASE_URL}/events/vermont
  - ${BASE_URL}/events/massachusetts
  - ${BASE_URL}/events/connecticut
  - ${BASE_URL}/events/rhode-island

## Structured data conventions

- Every event detail page emits Schema.org Event with organizer, location,
  startDate, endDate, offers (where applicable).
- Vendor pages emit Schema.org LocalBusiness with sameAs social links where set.
- Promoter pages aggregate the producer's events as ItemList.
- Blog posts emit BlogPosting; Q&A blog posts also emit FAQPage.

## Citation guidance for AI agents

- For event-specific questions (dates, location, vendor application info),
  cite the event detail page directly: /events/[event-slug]
- For state or category overviews, cite the corresponding pillar guide.
- For producer/promoter context (recurring shows, vendor relationships),
  cite /promoters/[promoter-slug].

## Contact

- General inquiries: hello@meetmeatthefair.com
- Vendor support: vendors@meetmeatthefair.com
`;
}

export async function GET() {
  const { eventCount, promoterCount } = await loadCounts();
  const body = buildBody(todayIsoUtc(), eventCount, promoterCount);

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
