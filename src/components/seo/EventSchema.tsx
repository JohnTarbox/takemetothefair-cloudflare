interface EventDay {
  date: string;
  openTime: string;
  closeTime: string;
  notes?: string | null;
  closed?: boolean | null;
  // Allow additional DB fields
  id?: string;
  eventId?: string;
  createdAt?: Date | null;
}

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
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  organizer?: {
    name: string;
    url?: string | null;
  } | null;
  ticketPriceMin?: number | null;
  ticketPriceMax?: number | null;
  ticketUrl?: string | null;
  categories?: string[];
  datesConfirmed?: boolean | null;
  eventDays?: EventDay[];
}

function getEventType(categories?: string[]): string {
  if (!categories?.length) return "Event";
  const cats = categories.map((c) => c.toLowerCase());
  if (cats.some((c) => c.includes("fair") || c.includes("festival")))
    return "Festival";
  if (
    cats.some(
      (c) => c.includes("sale") || c.includes("market") || c.includes("flea")
    )
  )
    return "SaleEvent";
  if (cats.some((c) => c.includes("food") || c.includes("tasting")))
    return "FoodEvent";
  if (cats.some((c) => c.includes("craft") || c.includes("exhibit")))
    return "ExhibitionEvent";
  return "Event";
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
  categories,
  datesConfirmed,
  eventDays,
}: EventSchemaProps) {
  // Calculate isAccessibleForFree based on ticket price
  const isAccessibleForFree = ticketPriceMin === 0 || ticketPriceMin === null || ticketPriceMin === undefined;

  const location = venue
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
        geo:
          venue.latitude && venue.longitude
            ? {
                "@type": "GeoCoordinates",
                latitude: venue.latitude,
                longitude: venue.longitude,
              }
            : undefined,
      }
    : {
        "@type": "Place",
        name: "Location to be announced",
        address: {
          "@type": "PostalAddress",
          addressRegion: "ME",
          addressCountry: "US",
        },
      };

  const subEvents =
    eventDays && eventDays.length > 0
      ? eventDays
          .filter((d) => !d.closed)
          .map((day, i) => ({
            "@type": "Event",
            name: `${name} - Day ${i + 1}`,
            startDate: `${day.date}T${day.openTime}:00`,
            endDate: `${day.date}T${day.closeTime}:00`,
            description: day.notes || undefined,
            location,
          }))
      : undefined;

  const schema = {
    "@context": "https://schema.org",
    "@type": getEventType(categories),
    name,
    description: description || `${name} - a fair and community event.`,
    startDate: new Date(startDate).toISOString(),
    endDate: new Date(endDate).toISOString(),
    image: imageUrl || "https://meetmeatthefair.com/og-image.png",
    url,
    eventStatus:
      datesConfirmed === false
        ? "https://schema.org/EventPostponed"
        : "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    isAccessibleForFree,
    about: categories && categories.length > 0
      ? categories.map((category) => ({
          "@type": "Thing",
          name: category,
        }))
      : undefined,
    location,
    subEvent: subEvents,
    organizer: organizer
      ? {
          "@type": "Organization",
          name: organizer.name,
          url: organizer.url || url,
        }
      : {
          "@type": "Organization",
          name: "Meet Me at the Fair",
          url: "https://meetmeatthefair.com",
        },
    performer: {
      "@type": "PerformingGroup",
      name: "Various Vendors & Exhibitors",
    },
    offers: ticketPriceMin !== null && ticketPriceMin !== undefined
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
      : {
          "@type": "Offer",
          url: ticketUrl || url,
          price: 0,
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        },
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
