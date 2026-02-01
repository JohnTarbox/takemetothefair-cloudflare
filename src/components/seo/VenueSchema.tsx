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
            ratingCount: googleRatingCount,
            bestRating: 5,
          }
        : undefined,
  };

  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}
