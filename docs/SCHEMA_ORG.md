# Schema.org Structured Data Documentation

This document covers the Schema.org structured data implementation in Meet Me at the Fair, which improves SEO and enables rich search results in Google.

## What is Schema.org?

Schema.org is a collaborative vocabulary that search engines use to understand web content. By adding structured data (JSON-LD) to pages, you help Google:

- Display **rich results** (event cards, business info, breadcrumbs, FAQs)
- Understand **entity relationships** (which vendor is at which event)
- Improve **search accuracy** for users looking for local events

**Test your pages**: [Google Rich Results Test](https://search.google.com/test/rich-results)

---

## Supported Schema Types

| Schema Type | Component | Used On |
|------------|-----------|---------|
| Event | `EventSchema` | Event detail pages |
| Place | `VenueSchema` | Venue detail pages |
| LocalBusiness / FoodEstablishment / Store | `VendorSchema` | Vendor detail pages |
| Organization + WebSite | `OrganizationSchema` | Homepage (site-wide) |
| BreadcrumbList | `BreadcrumbSchema` | Detail pages |
| ItemList | `ItemListSchema` | Listing pages |
| FAQPage | `FAQSchema` | Contact page |

---

## Component Reference

All components are located in `src/components/seo/`.

### EventSchema

**File**: `src/components/seo/EventSchema.tsx`

**Used on**: `/events/[slug]`

Generates Schema.org Event markup for fairs and festivals. This is the most important schema for the site as it enables event rich results in Google Search.

#### Props Interface

```typescript
interface EventSchemaProps {
  name: string;                    // Required: Event name
  description?: string;            // Event description
  startDate: Date;                 // Required: When event starts
  endDate: Date;                   // Required: When event ends
  imageUrl?: string | null;        // Event image (falls back to site default)
  url: string;                     // Required: Canonical URL of event page
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
  ticketPriceMin?: number | null;  // Lowest ticket price (0 = free)
  ticketPriceMax?: number | null;  // Highest ticket price
  ticketUrl?: string | null;       // Where to buy tickets
  categories?: string[];           // Event categories
}
```

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "Maine State Fair",
  "description": "Annual agricultural fair featuring livestock, crafts, and food vendors.",
  "startDate": "2026-08-20T00:00:00.000Z",
  "endDate": "2026-08-29T00:00:00.000Z",
  "image": "https://meetmeatthefair.com/uploads/maine-state-fair.jpg",
  "url": "https://meetmeatthefair.com/events/maine-state-fair",
  "eventStatus": "https://schema.org/EventScheduled",
  "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
  "isAccessibleForFree": false,
  "location": {
    "@type": "Place",
    "name": "Skowhegan Fairgrounds",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "146 Water Street",
      "addressLocality": "Skowhegan",
      "addressRegion": "ME",
      "postalCode": "04976",
      "addressCountry": "US"
    },
    "geo": {
      "@type": "GeoCoordinates",
      "latitude": 44.7647,
      "longitude": -69.7192
    }
  },
  "organizer": {
    "@type": "Organization",
    "name": "Skowhegan State Fair Association",
    "url": "https://skowheganstatefair.com"
  },
  "offers": {
    "@type": "Offer",
    "url": "https://meetmeatthefair.com/events/maine-state-fair",
    "price": 10,
    "priceCurrency": "USD",
    "availability": "https://schema.org/InStock",
    "highPrice": 15
  }
}
```

#### Data Requirements for Best Results

| Field | Impact | Recommendation |
|-------|--------|----------------|
| name | High | Clear, descriptive name |
| startDate/endDate | High | Always required for event rich results |
| venue with address | High | Complete address enables "Events near me" |
| venue with lat/lng | Medium | Enables map integration |
| imageUrl | Medium | Use 16:9 aspect ratio, min 720px wide |
| ticketPriceMin | Medium | Set to 0 for free events |
| description | Low | 150-300 characters recommended |

---

### VenueSchema

**File**: `src/components/seo/VenueSchema.tsx`

**Used on**: `/venues/[slug]`

Generates Schema.org Place markup for fairgrounds, parks, and event spaces.

#### Props Interface

```typescript
interface VenueSchemaProps {
  name: string;                   // Required: Venue name
  description?: string | null;
  imageUrl?: string | null;
  url: string;                    // Required: Canonical URL
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capacity?: number | null;       // Maximum attendee capacity
  telephone?: string | null;
  amenities?: string[];           // Parking, restrooms, etc.
}
```

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@type": "Place",
  "name": "Skowhegan Fairgrounds",
  "description": "Historic fairgrounds hosting the oldest agricultural fair in Maine.",
  "url": "https://meetmeatthefair.com/venues/skowhegan-fairgrounds",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "146 Water Street",
    "addressLocality": "Skowhegan",
    "addressRegion": "ME",
    "postalCode": "04976",
    "addressCountry": "US"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 44.7647,
    "longitude": -69.7192
  },
  "hasMap": "https://www.google.com/maps?q=44.7647,-69.7192",
  "maximumAttendeeCapacity": 15000,
  "amenityFeature": [
    { "@type": "LocationFeatureSpecification", "name": "Free Parking", "value": true },
    { "@type": "LocationFeatureSpecification", "name": "Restrooms", "value": true }
  ]
}
```

---

### VendorSchema

**File**: `src/components/seo/VendorSchema.tsx`

**Used on**: `/vendors/[slug]`

Generates Schema.org LocalBusiness (or subtype) markup for vendors. The schema type is automatically selected based on vendor type:

- **FoodEstablishment**: food, restaurant, catering, bakery, cafe
- **Store**: craft, artisan, handmade, jewelry, retail, shop, boutique
- **LocalBusiness**: default for other types

#### Props Interface

```typescript
interface VendorSchemaProps {
  businessName: string;           // Required: Business name
  description?: string | null;
  logoUrl?: string | null;
  url: string;                    // Required: Canonical URL
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  telephone?: string | null;
  email?: string | null;
  website?: string | null;        // External business website
  yearEstablished?: number | null;
  paymentMethods?: string[];      // Cash, Credit Cards, etc.
  socialLinks?: Record<string, string> | null;  // facebook, instagram, etc.
  products?: string[];            // Products/services offered
  vendorType?: string | null;     // Determines schema subtype
}
```

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@type": "FoodEstablishment",
  "name": "Betty's Homemade Pies",
  "description": "Award-winning homemade pies using local Maine ingredients.",
  "url": "https://meetmeatthefair.com/vendors/bettys-homemade-pies",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "Portland",
    "addressRegion": "ME",
    "addressCountry": "US"
  },
  "telephone": "(207) 555-0123",
  "email": "betty@bettypies.com",
  "foundingDate": "2015",
  "paymentAccepted": "Cash, Credit Cards",
  "sameAs": [
    "https://bettypies.com",
    "https://facebook.com/bettypies"
  ],
  "makesOffer": [
    {
      "@type": "Offer",
      "itemOffered": { "@type": "Product", "name": "Apple Pie" }
    },
    {
      "@type": "Offer",
      "itemOffered": { "@type": "Product", "name": "Blueberry Pie" }
    }
  ]
}
```

---

### OrganizationSchema

**File**: `src/components/seo/OrganizationSchema.tsx`

**Used on**: Homepage (`/`)

Site-wide schema that defines the organization and website. Uses `@graph` to include both Organization and WebSite schemas with linked IDs. Also defines a SearchAction for sitelinks search box.

#### Props Interface

No props - this component uses hardcoded site information.

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://meetmeatthefair.com/#organization",
      "name": "Meet Me at the Fair",
      "url": "https://meetmeatthefair.com",
      "description": "Find fairs, festivals, and community events in your area.",
      "logo": {
        "@type": "ImageObject",
        "url": "https://meetmeatthefair.com/icon.png"
      },
      "sameAs": [
        "https://facebook.com/meetmeatthefair",
        "https://instagram.com/meetmeatthefair"
      ],
      "contactPoint": {
        "@type": "ContactPoint",
        "email": "hello@meetmeatthefair.com",
        "contactType": "customer service"
      }
    },
    {
      "@type": "WebSite",
      "@id": "https://meetmeatthefair.com/#website",
      "url": "https://meetmeatthefair.com",
      "name": "Meet Me at the Fair",
      "publisher": { "@id": "https://meetmeatthefair.com/#organization" },
      "potentialAction": {
        "@type": "SearchAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": "https://meetmeatthefair.com/events?query={search_term_string}"
        },
        "query-input": "required name=search_term_string"
      }
    }
  ]
}
```

---

### BreadcrumbSchema

**File**: `src/components/seo/BreadcrumbSchema.tsx`

**Used on**: Event, venue, and vendor detail pages

Generates breadcrumb navigation markup that can appear in search results.

#### Props Interface

```typescript
interface BreadcrumbItem {
  name: string;  // Display text
  url: string;   // Full URL
}

interface BreadcrumbSchemaProps {
  items: BreadcrumbItem[];
}
```

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://meetmeatthefair.com" },
    { "@type": "ListItem", "position": 2, "name": "Events", "item": "https://meetmeatthefair.com/events" },
    { "@type": "ListItem", "position": 3, "name": "Maine State Fair", "item": "https://meetmeatthefair.com/events/maine-state-fair" }
  ]
}
```

---

### ItemListSchema

**File**: `src/components/seo/ItemListSchema.tsx`

**Used on**: `/events`, `/venues`, `/vendors`, `/events/[slug]/vendors`, `/vendors/[slug]/events`

Generates ItemList markup for listing pages, limited to first 30 items to keep payload reasonable.

#### Props Interface

```typescript
type ItemListOrder = "ascending" | "descending" | "unordered";

interface ItemListSchemaProps {
  name: string;              // List title
  description?: string;
  items: Array<{
    name: string;
    url: string;
    image?: string | null;
  }>;
  order?: ItemListOrder;     // Default: "ascending"
}
```

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Upcoming Events",
  "description": "Fairs, festivals, and community events",
  "numberOfItems": 12,
  "itemListOrder": "https://schema.org/ItemListOrderAscending",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Maine State Fair", "url": "https://meetmeatthefair.com/events/maine-state-fair" },
    { "@type": "ListItem", "position": 2, "name": "Fryeburg Fair", "url": "https://meetmeatthefair.com/events/fryeburg-fair" }
  ]
}
```

---

### FAQSchema

**File**: `src/components/seo/FAQSchema.tsx`

**Used on**: `/contact`

Generates FAQPage markup for frequently asked questions, enabling FAQ rich results.

#### Props Interface

```typescript
interface FAQSchemaProps {
  items: Array<{
    question: string;
    answer: string;
  }>;
}
```

#### Example Output

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How do I add my event to the site?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Create a promoter account and submit your event for approval."
      }
    },
    {
      "@type": "Question",
      "name": "Is there a cost to list events?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No, listing events is completely free."
      }
    }
  ]
}
```

---

## For Content Editors

### How Data Affects Search Results

When you fill in event, venue, or vendor details, that information directly impacts how pages appear in Google:

| Field You Fill In | Search Result Impact |
|------------------|---------------------|
| Event name + dates | Event card in Google Search |
| Venue address | "Events near me" results |
| Event image | Thumbnail in search results |
| Ticket price | Price shown in event card |
| FAQ questions | Expandable FAQ in search results |
| Vendor products | Can appear in product searches |

### Tips for Better Rich Results

1. **Always add images** - Events and vendors with images get better engagement
2. **Complete addresses** - Full street address + city + state + zip enables map features
3. **Add coordinates** - Latitude/longitude improves location accuracy
4. **Set ticket prices** - Even if free, set price to $0 (shows "Free" in results)
5. **Write descriptions** - 150-300 characters is ideal for search snippets
6. **Add vendor products** - List specific products for better product search visibility

---

## For Developers

### Adding Schema to a New Page

1. Import the appropriate schema component:

```typescript
import { EventSchema } from "@/components/seo/EventSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
```

2. Add schema components in your page's return statement (typically at the end):

```tsx
export default async function EventPage({ params }: Props) {
  const event = await getEvent(params.slug);

  return (
    <>
      {/* Page content */}
      <main>
        <h1>{event.name}</h1>
        {/* ... */}
      </main>

      {/* Schema markup - invisible to users, read by search engines */}
      <EventSchema
        name={event.name}
        description={event.description}
        startDate={event.startDate}
        endDate={event.endDate}
        url={`https://meetmeatthefair.com/events/${event.slug}`}
        venue={event.venue}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Events", url: "https://meetmeatthefair.com/events" },
          { name: event.name, url: `https://meetmeatthefair.com/events/${event.slug}` },
        ]}
      />
    </>
  );
}
```

### Extending Existing Schemas

To add new properties to a schema:

1. Update the props interface
2. Add the property to the schema object
3. Use `undefined` for optional properties (they'll be stripped by `JSON.parse(JSON.stringify())`)

Example - adding `previousStartDate` to EventSchema:

```typescript
interface EventSchemaProps {
  // ... existing props
  previousStartDate?: Date | null;  // For rescheduled events
}

const schema = {
  // ... existing properties
  previousStartDate: previousStartDate
    ? new Date(previousStartDate).toISOString()
    : undefined,
};
```

### Creating a New Schema Component

Follow this pattern:

```tsx
interface NewSchemaProps {
  // Define your props
}

export function NewSchema(props: NewSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "YourSchemaType",
    // Map props to schema properties
    // Use `undefined` for optional values (not null)
  };

  // Remove undefined values
  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}
```

### Testing Your Schema

1. **During development**: View page source and find `<script type="application/ld+json">`
2. **Validate JSON**: Paste the JSON into [Google Rich Results Test](https://search.google.com/test/rich-results)
3. **Check for warnings**: Google shows warnings for missing recommended properties

### Common Issues

**Schema not appearing**: Make sure the component is inside the page's return statement, not in a layout.

**Invalid JSON**: Check for trailing commas or undefined values that didn't get cleaned up.

**Properties not showing**: Ensure you're passing actual values, not empty strings (use `undefined` instead).

---

## Resources

- [Schema.org Event](https://schema.org/Event)
- [Schema.org Place](https://schema.org/Place)
- [Schema.org LocalBusiness](https://schema.org/LocalBusiness)
- [Google Event Structured Data](https://developers.google.com/search/docs/appearance/structured-data/event)
- [Google Rich Results Test](https://search.google.com/test/rich-results)
- [Schema.org Validator](https://validator.schema.org/)
