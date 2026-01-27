interface EventSchemaProps {
  name: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  imageUrl?: string | null;
  url: string;
  venue?: {
    name: string;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
  organizer?: {
    name: string;
    url?: string | null;
  } | null;
  ticketPriceMin?: number | null;
  ticketPriceMax?: number | null;
  ticketUrl?: string | null;
}

export function EventSchema({
  name,
  description,
  startDate,
  endDate,
  imageUrl,
  url,
  venue,
  organizer,
  ticketPriceMin,
  ticketPriceMax,
  ticketUrl,
}: EventSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Event",
    name,
    description: description || undefined,
    startDate: new Date(startDate).toISOString(),
    endDate: new Date(endDate).toISOString(),
    image: imageUrl || undefined,
    url,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: venue
      ? {
          "@type": "Place",
          name: venue.name,
          address: {
            "@type": "PostalAddress",
            streetAddress: venue.address || undefined,
            addressLocality: venue.city || undefined,
            addressRegion: venue.state || undefined,
            postalCode: venue.zip || undefined,
            addressCountry: "US",
          },
        }
      : undefined,
    organizer: organizer
      ? {
          "@type": "Organization",
          name: organizer.name,
          url: organizer.url || undefined,
        }
      : undefined,
    offers:
      ticketPriceMin !== null && ticketPriceMin !== undefined
        ? {
            "@type": "Offer",
            url: ticketUrl || url,
            price: ticketPriceMin,
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            validFrom: new Date().toISOString(),
            ...(ticketPriceMax !== null &&
              ticketPriceMax !== undefined &&
              ticketPriceMax !== ticketPriceMin && {
                highPrice: ticketPriceMax,
              }),
          }
        : undefined,
  };

  // Remove undefined values for cleaner output
  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}
