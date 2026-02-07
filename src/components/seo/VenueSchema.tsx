interface VenueSchemaProps {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  url: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capacity?: number | null;
  telephone?: string | null;
  amenities?: string[];
  googleRating?: number | null;
  googleRatingCount?: number | null;
  openingHours?: string | null;
  accessibility?: string[];
  website?: string | null;
}

interface OpeningHoursSpec {
  "@type": "OpeningHoursSpecification";
  dayOfWeek: string | string[];
  opens: string;
  closes: string;
}

function parseOpeningHours(hoursString: string): OpeningHoursSpec[] | undefined {
  try {
    const parsed = JSON.parse(hoursString);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        "@type": "OpeningHoursSpecification" as const,
        dayOfWeek: item.dayOfWeek || item.day,
        opens: item.opens || item.open,
        closes: item.closes || item.close,
      })).filter(spec => spec.dayOfWeek && spec.opens && spec.closes);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function VenueSchema({
  name,
  description,
  imageUrl,
  url,
  address,
  city,
  state,
  zip,
  latitude,
  longitude,
  capacity,
  telephone,
  amenities,
  googleRating,
  googleRatingCount,
  openingHours,
  accessibility,
  website,
}: VenueSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Place",
    name,
    description: description || undefined,
    image: imageUrl || undefined,
    url,
    address: {
      "@type": "PostalAddress",
      streetAddress: address || undefined,
      addressLocality: city || undefined,
      addressRegion: state || undefined,
      postalCode: zip || undefined,
      addressCountry: "US",
    },
    geo:
      latitude && longitude
        ? {
            "@type": "GeoCoordinates",
            latitude,
            longitude,
          }
        : undefined,
    hasMap:
      latitude && longitude
        ? `https://www.google.com/maps?q=${latitude},${longitude}`
        : undefined,
    maximumAttendeeCapacity: capacity || undefined,
    telephone: telephone || undefined,
    amenityFeature:
      amenities && amenities.length > 0
        ? amenities.map((a) => ({
            "@type": "LocationFeatureSpecification",
            name: a,
            value: true,
          }))
        : undefined,
    aggregateRating:
      googleRating && googleRatingCount
        ? {
            "@type": "AggregateRating",
            ratingValue: googleRating,
            reviewCount: googleRatingCount,
            bestRating: 5,
            worstRating: 1,
          }
        : undefined,
    openingHoursSpecification: openingHours
      ? parseOpeningHours(openingHours)
      : undefined,
    accessibilityFeature:
      accessibility && accessibility.length > 0 ? accessibility : undefined,
    sameAs: website ? [website] : undefined,
  };

  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}
