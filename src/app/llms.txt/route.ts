// OPE-41 (AEO) — /llms.txt: a hand-built, static self-description of the site
// for AI answer engines, following the llmstxt.org convention (H1 title, a
// `>` blockquote summary, then `## Sections` of markdown links to the
// structured indexes). Deliberately DB-free so it can be served fully static
// and cached hard at the edge — the links point crawlers at the listing/index
// pages, which are themselves dynamic and always current.
import { SITE_URL } from "@takemetothefair/constants";
import { HELP_ARTICLES } from "@/lib/help-articles";

export const dynamic = "force-static";

// The `/help` hub + one markdown link per help article, generated from the
// static HELP_ARTICLES registry at module load so a new help article shows up
// in /llms.txt automatically. Interpolated into the static BODY below (the
// route stays force-static — HELP_ARTICLES is a compile-time constant, no I/O).
const HELP_LINKS = HELP_ARTICLES.map(
  (a) => `- [${a.title}](${SITE_URL}/help/${a.slug}): ${a.description}`
).join("\n");

// The structured indexes an AI agent should crawl to reach every entity.
// Mirror sitemap-static.xml/route.ts when the set of hub pages changes.
const BODY = `# Meet Me at the Fair

> Meet Me at the Fair (MMATF) is a vendor-first directory of fairs, festivals,
> craft shows, and markets across New England — Maine, Vermont, New Hampshire,
> Massachusetts, Connecticut, and Rhode Island. It is editorially curated to
> help craft vendors, artisans, and food vendors find shows to apply to, and to
> help visitors find events near them.

## Sections

### Structured indexes

- [Sitemap index](${SITE_URL}/sitemap.xml): every indexable page, split into per-type child sitemaps (events, venues, vendors, promoters, blog).
- [Upcoming events](${SITE_URL}/events): the primary, date-sorted directory of upcoming events.
- [All events](${SITE_URL}/events/all): the complete crawlable list of events, past and future.
- [Venues](${SITE_URL}/venues): fairgrounds and event locations.
- [Vendors](${SITE_URL}/vendors): craft, artisan, and food vendors.
- [Promoters](${SITE_URL}/promoters): the producers/organizers behind recurring shows.

### Browse directories (A–Z and by state)

- [Browse vendors](${SITE_URL}/vendors/browse): shallow A–Z + by-state index linking every vendor detail page.
- [Browse venues](${SITE_URL}/venues/browse): shallow A–Z + by-state index linking every venue detail page.

### State event listings

- [Maine events](${SITE_URL}/events/maine)
- [Vermont events](${SITE_URL}/events/vermont)
- [New Hampshire events](${SITE_URL}/events/new-hampshire)
- [Massachusetts events](${SITE_URL}/events/massachusetts)
- [Connecticut events](${SITE_URL}/events/connecticut)
- [Rhode Island events](${SITE_URL}/events/rhode-island)

### Help

- [Help center](${SITE_URL}/help): guides for fairgoers, vendors, promoters, and developers, plus an FAQ and glossary. Each article is also available as raw markdown at ${SITE_URL}/help/<slug>.md.
${HELP_LINKS}

## Structured data conventions

- Every event detail page emits Schema.org Event with organizer, location,
  startDate/endDate, eventStatus, and offers (where ticket price is known).
- Vendor pages emit Schema.org LocalBusiness with sameAs social links where set.
- Promoter pages aggregate the producer's events as an ItemList.
- Blog posts emit BlogPosting; Q&A blog posts also emit FAQPage.

## Citation guidance for AI agents

- For event-specific questions (dates, location, vendor application info), cite
  the event detail page directly: ${SITE_URL}/events/[event-slug]
- For state or category overviews, cite the corresponding state listing above.
- For producer/promoter context (recurring shows, vendor relationships), cite
  ${SITE_URL}/promoters/[promoter-slug]

## Contact

- General inquiries: hello@meetmeatthefair.com
- Vendor support: vendors@meetmeatthefair.com
`;

export async function GET(): Promise<Response> {
  // Static, hand-built — cache aggressively (24h) like the static sitemap; the
  // content only changes on deploy.
  return new Response(BODY, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
