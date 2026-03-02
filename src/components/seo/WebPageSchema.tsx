type WebPageType = "WebPage" | "ContactPage" | "AboutPage" | "CollectionPage";

interface WebPageSchemaProps {
  type?: WebPageType;
  name: string;
  description: string;
  url: string;
}

export function WebPageSchema({
  type = "WebPage",
  name,
  description,
  url,
}: WebPageSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": type,
    name,
    description,
    url,
    isPartOf: {
      "@id": "https://meetmeatthefair.com/#website",
    },
    about: {
      "@id": "https://meetmeatthefair.com/#organization",
    },
  };

  // Schema data is constructed from trusted server-side props only
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
