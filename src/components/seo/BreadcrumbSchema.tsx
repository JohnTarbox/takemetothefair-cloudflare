import { SITE_URL } from "@takemetothefair/constants";

/**
 * OPE-631 — Google maps breadcrumb `item` to `@id` and REQUIRES an absolute URL.
 *
 * Six of this component's 35 callers hand it root-relative paths (the whole
 * `/vendors/browse` and `/venues/browse` subtree, all spelled
 * `{ name: "Home", url: "/" }`), so the served JSON-LD carried
 * `"item":"/vendors/browse/state/wi"`. GSC rejects it as *"Invalid URL in field
 * id"* and reports the item name as `N/A`: the page stays valid, it just
 * forfeits the breadcrumb rich result. 91 pages are affected; GSC had crawled
 * four of them when this was filed.
 *
 * Fixed HERE rather than at the six call sites, for the same reason the OPE-182
 * `<` escaping below lives here: 35 callers, and a call-site fix leaves the
 * next caller free to reintroduce it.
 *
 * `SITE_URL` carries no trailing slash, so the root case is returned as-is
 * rather than concatenated — `SITE_URL + "/"` would emit a double slash and
 * disagree with the 29 callers already passing absolute URLs.
 */
export function absolutizeBreadcrumbUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url === "/") return SITE_URL;
  return url.startsWith("/") ? `${SITE_URL}${url}` : `${SITE_URL}/${url}`;
}

interface BreadcrumbItem {
  name: string;
  url: string;
}

interface BreadcrumbSchemaProps {
  items: BreadcrumbItem[];
}

export function BreadcrumbSchema({ items }: BreadcrumbSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absolutizeBreadcrumbUrl(item.url),
    })),
  };

  return (
    <script
      type="application/ld+json"
      // OPE-182 — escape `<` so a breadcrumb `name` containing `</script>` (event/
      // venue/vendor/blog titles are first-party but operator-entered) can't break
      // out of the JSON-LD block. Mirrors the same defense in the series/event
      // JSON-LD emitters; hardening it here covers all ~30 BreadcrumbSchema callers.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }}
    />
  );
}
