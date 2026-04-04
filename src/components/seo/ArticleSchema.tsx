interface ArticleSchemaProps {
  headline: string;
  description?: string | null;
  datePublished?: Date | string | null;
  dateModified?: Date | string | null;
  authorName?: string | null;
  image?: string | null;
  url: string;
  wordCount?: number;
  readingTimeMinutes?: number;
  tags?: string[];
  categories?: string[];
}

export function ArticleSchema({
  headline,
  description,
  datePublished,
  dateModified,
  authorName,
  image,
  url,
  wordCount,
  readingTimeMinutes,
  tags,
  categories,
}: ArticleSchemaProps) {
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    publisher: {
      "@type": "Organization",
      name: "Meet Me at the Fair",
      url: "https://meetmeatthefair.com",
      logo: {
        "@type": "ImageObject",
        url: "https://meetmeatthefair.com/og-default.png",
      },
    },
  };

  if (description) schema.description = description;

  if (datePublished) {
    schema.datePublished = new Date(datePublished).toISOString();
  }

  if (dateModified) {
    schema.dateModified = new Date(dateModified).toISOString();
  }

  if (authorName) {
    schema.author = { "@type": "Person", name: authorName };
  }

  if (image) {
    schema.image = {
      "@type": "ImageObject",
      url: image,
      width: 1200,
      height: 630,
    };
  }

  if (wordCount) schema.wordCount = wordCount;

  if (readingTimeMinutes) {
    schema.timeRequired = `PT${readingTimeMinutes}M`;
  }

  if (tags && tags.length > 0) {
    schema.keywords = tags.join(", ");
  }

  if (categories && categories.length > 0) {
    schema.articleSection = categories[0];
  }

  // JSON.stringify produces safe output for JSON-LD script tags —
  // all values come from our own database, not user-generated HTML
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
