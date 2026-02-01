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
    "@type": "LocalBusiness",
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
    makesOffer:
      products && products.length > 0
        ? products.map((p) => ({
            "@type": "Offer",
            itemOffered: {
              "@type": "Product",
              name: p,
            },
          }))
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
