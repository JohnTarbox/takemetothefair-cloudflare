// Map common vendor types to schema.org LocalBusiness subtypes
function getSchemaType(vendorType?: string | null): string {
  if (!vendorType) return "LocalBusiness";

  const type = vendorType.toLowerCase();

  // Food-related types
  if (
    type.includes("food") ||
    type.includes("restaurant") ||
    type.includes("catering") ||
    type.includes("bakery") ||
    type.includes("cafe")
  ) {
    return "FoodEstablishment";
  }

  // Craft/artisan/retail types
  if (
    type.includes("craft") ||
    type.includes("artisan") ||
    type.includes("handmade") ||
    type.includes("jewelry") ||
    type.includes("retail") ||
    type.includes("shop") ||
    type.includes("boutique")
  ) {
    return "Store";
  }

  return "LocalBusiness";
}

function getPriceRange(vendorType?: string | null): string {
  if (!vendorType) return "$-$$";
  const type = vendorType.toLowerCase();
  if (type.includes("food") || type.includes("bakery") || type.includes("cafe")) return "$";
  if (
    type.includes("craft") ||
    type.includes("artisan") ||
    type.includes("handmade") ||
    type.includes("jewelry")
  )
    return "$$";
  return "$-$$";
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
  // Round-3 additions: Enhanced Profile vendors emit an array of images
  // (logo + gallery) so social/AI crawlers see the full visual set.
  galleryImageUrls?: string[];
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
  galleryImageUrls,
}: VendorSchemaProps) {
  const sameAs: string[] = [];
  if (website) sameAs.push(website);
  if (socialLinks) {
    Object.values(socialLinks).forEach((link) => {
      if (link) sameAs.push(link);
    });
  }

  // image: scalar for free vendors, array for Enhanced (logo + gallery).
  // schema.org accepts both shapes; the array signals to crawlers that the
  // entity has multiple representative images.
  const imageField = (() => {
    const images = [logoUrl, ...(galleryImageUrls ?? [])].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    if (images.length === 0) return undefined;
    if (images.length === 1) return images[0];
    return images;
  })();

  const schema = {
    "@context": "https://schema.org",
    "@type": getSchemaType(vendorType),
    name: businessName,
    description: description || undefined,
    image: imageField,
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
      paymentMethods && paymentMethods.length > 0 ? paymentMethods.join(", ") : undefined,
    sameAs: sameAs.length > 0 ? sameAs : undefined,
    priceRange: getPriceRange(vendorType),
    hasOfferCatalog:
      products && products.length > 0
        ? {
            "@type": "OfferCatalog",
            name: "Products & Services",
            itemListElement: products.map((p) => ({
              "@type": "Offer",
              itemOffered: {
                "@type": "Service",
                name: p,
              },
            })),
          }
        : undefined,
    areaServed: state
      ? {
          "@type": "State",
          name: state,
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
