import { ParsedSitemap } from "./types";

export async function parseSitemap(sitemapUrl: string): Promise<ParsedSitemap> {
  const response = await fetch(sitemapUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();

  // Extract all URLs from sitemap using regex
  const allUrls: string[] = [];
  const regex = /<loc>([^<]+)<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    allUrls.push(match[1]);
  }

  // Filter by entity type - only get individual entity pages (with slugs)
  const vendors = allUrls.filter((url) => {
    const match = url.match(/\/vendors\/([^/]+)$/);
    return match && match[1] !== "";
  });

  const events = allUrls.filter((url) => {
    const match = url.match(/\/events\/([^/]+)$/);
    return match && match[1] !== "";
  });

  const venues = allUrls.filter((url) => {
    const match = url.match(/\/venues\/([^/]+)$/);
    return match && match[1] !== "";
  });

  return {
    vendors,
    events,
    venues,
    all: [...vendors, ...events, ...venues],
  };
}
