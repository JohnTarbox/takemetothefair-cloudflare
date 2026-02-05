// Map common vendor types to schema.org LocalBusiness subtypes
function getSchemaType(vendorType?: string | null): string {
  if (!vendorType) return "LocalBusiness";

  const type = vendorType.toLowerCase();

  // Food-related types
  if (type.includes("food") || type.includes("restaurant") || type.includes("catering") || type.includes("bakery") || type.includes("cafe")) {
    return "FoodEstablishment";
  }

  // Craft/artisan/retail types
  if (type.includes("craft") || type.includes("artisan") || type.includes("handmade") || type.includes("jewelry") || type.includes("retail") || type.includes("shop") || type.includes("boutique")) {
    return "Store";
  }

  return "LocalBusiness";
}

interface VendorSchemaProps {
  businessName: string;
  description?: string | null;
  logoUrl?: string | null;
  url: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  telephone?: string | null;
  email?: string | null;
  website?: string | null;
  yearEstablished?: number | null;
  paymentMethods?: string[];
  socialLinks?: Record<string, string> | null;
  products?: string[];
  vendorType?: string | null;
}

export function VendorSchema({
  businessName,
  description,
  logoUrl,
  url,
  address,
  city,
  state,
  zip,
  telephone,
  email,
  website,
  yearEstablished,
  paymentMethods,
  socialLinks,
  products,
  vendorType,
}: VendorSchemaProps) {
  const sameAs: string[] = [];
  if (website) sameAs.push(website);
  if (socialLinks) {
    Object.values(socialLinks).forEach((link) => {
      if (link) sameAs.push(link);
    });
  }

  const schema = {
    "@context": "https://schema.org",
    "@type": getSchemaType(vendorType),
    name: businessName,
    description: description || undefined,
    image: logoUrl || undefined,
    url,
    address:
      city || address
        ? {
            "@type": "PostalAddress",
            streetAddress: address || undefined,
            addressLocality: city || undefined,
            addressRegion: state || undefined,
            postalCode: zip || undefined,
            addressCountry: "US",
          }
        : undefined,
    telephone: telephone || undefined,
    email: email || undefined,
    foundingDate: yearEstablished ? String(yearEstablished) : undefined,
    paymentAccepted:
      paymentMethods && paymentMethods.length > 0
        ? paymentMethods.join(", ")
        : undefined,
    sameAs: sameAs.length > 0 ? sameAs : undefined,
    // Use hasOfferCatalog with product names as OfferCatalog items
    // This avoids Product schema validation issues (requires offers/review/aggregateRating)
    hasOfferCatalog:
      products && products.length > 0
        ? {
            "@type": "OfferCatalog",
            name: `${businessName} Products`,
            itemListElement: products.map((p, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: p,
            })),
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
