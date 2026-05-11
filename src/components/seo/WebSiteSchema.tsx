// Emits the WebSite + SearchAction JSON-LD node on the homepage only.
// References the Organization emitted site-wide by <OrganizationSchema> via
// its stable @id, so the two surfaces stay linked without duplicating the
// SearchAction on every page.
//
// SearchAction's urlTemplate must match the actual search-query endpoint —
// see /events?query=... in src/app/events/page.tsx.

export function WebSiteSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": "https://meetmeatthefair.com/#website",
    url: "https://meetmeatthefair.com",
    name: "Meet Me at the Fair",
    publisher: {
      "@id": "https://meetmeatthefair.com/#organization",
    },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: "https://meetmeatthefair.com/events?query={search_term_string}",
      },
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
