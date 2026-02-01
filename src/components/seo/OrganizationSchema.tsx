export function OrganizationSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://meetmeatthefair.com/#organization",
        name: "Meet Me at the Fair",
        url: "https://meetmeatthefair.com",
        description:
          "Find fairs, festivals, and community events in your area. Connect with vendors and promoters.",
        logo: {
          "@type": "ImageObject",
          url: "https://meetmeatthefair.com/icon.png",
        },
      },
      {
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
            urlTemplate:
              "https://meetmeatthefair.com/events?query={search_term_string}",
          },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
