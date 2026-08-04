export const dynamic = "force-dynamic";
import {
  SITEMAP_BASE_URL,
  serializeSitemapIndex,
  conditionalXmlResponse,
  type SitemapIndexEntry,
} from "@/lib/sitemap-xml";
import { getSitemapTypeLastMod, type SitemapType } from "@/lib/sitemap-lastmod";

// Sitemap index. References the six per-content-type child sitemaps. When
// adding a new content-type, mirror the new (filename, type) entry here.
//
// Each child's <lastmod> reflects MAX(updated_at) for its underlying row
// set (analyst 2026-05-22 P4a). Before this change every child carried an
// identical "now" timestamp, which gave Google no signal about which type
// actually changed — defeating most of the point of splitting the sitemap.
const CHILD_SITEMAPS: ReadonlyArray<{ file: string; type: SitemapType }> = [
  { file: "sitemap-static.xml", type: "static" },
  { file: "sitemap-events.xml", type: "events" },
  { file: "sitemap-venues.xml", type: "venues" },
  { file: "sitemap-vendors.xml", type: "vendors" },
  { file: "sitemap-promoters.xml", type: "promoters" },
  { file: "sitemap-blog.xml", type: "blog" },
  { file: "sitemap-performers.xml", type: "performers" }, // OPE-115
];

export async function GET(request: Request): Promise<Response> {
  const lastMods = await Promise.all(CHILD_SITEMAPS.map(({ type }) => getSitemapTypeLastMod(type)));
  const entries: SitemapIndexEntry[] = CHILD_SITEMAPS.map(({ file }, i) => {
    const entry: SitemapIndexEntry = { loc: `${SITEMAP_BASE_URL}/${file}` };
    const lastMod = lastMods[i];
    if (lastMod) entry.lastmod = lastMod;
    return entry;
  });
  // OPE-333 — the index's own Last-Modified is the newest of its children:
  // if any child changed, the index's <lastmod> for it changed, so the index
  // body changed too. Nulls (a type with no rows) drop out rather than
  // becoming epoch 0, which would pin the index permanently stale.
  const newest = lastMods.filter((d): d is Date => d instanceof Date);
  return await conditionalXmlResponse({
    request,
    body: serializeSitemapIndex(entries),
    lastModified: newest.length ? new Date(Math.max(...newest.map((d) => d.getTime()))) : null,
  });
}
