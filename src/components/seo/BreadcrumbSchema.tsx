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
      item: item.url,
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
