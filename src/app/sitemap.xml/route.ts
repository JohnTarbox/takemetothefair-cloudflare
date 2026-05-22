import {
  SITEMAP_BASE_URL,
  serializeSitemapIndex,
  sitemapXmlHeaders,
  type SitemapIndexEntry,
} from "@/lib/sitemap-xml";
import { getSitemapTypeLastMod, type SitemapType } from "@/lib/sitemap-lastmod";

export const runtime = "edge";

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
];

export async function GET(): Promise<Response> {
  const lastMods = await Promise.all(CHILD_SITEMAPS.map(({ type }) => getSitemapTypeLastMod(type)));
  const entries: SitemapIndexEntry[] = CHILD_SITEMAPS.map(({ file }, i) => {
    const entry: SitemapIndexEntry = { loc: `${SITEMAP_BASE_URL}/${file}` };
    const lastMod = lastMods[i];
    if (lastMod) entry.lastmod = lastMod;
    return entry;
  });
  return new Response(serializeSitemapIndex(entries), {
    headers: sitemapXmlHeaders(3600),
  });
}
