// Emits the Organization JSON-LD node site-wide via root layout. WebSite +
// SearchAction live in <WebSiteSchema> (homepage only) and reference this
// Organization by its stable @id, so the two surfaces stay linked without
// duplicating SearchAction on every page.

import { SOCIAL_LINKS } from "@/lib/social-links";

// TODO(jtarbox): confirm canonical logo URL — currently the OG default
// PNG, which works but is not a branded logo asset.
const LOGO_URL = "https://meetmeatthefair.com/og-default.png";

// sameAs asserts Organization-level identity. Only include URLs that
// resolve to a profile owned by MMATF and branded as such — pointing at a
// personal or unrelated account weakens the Knowledge Graph signal.
//
// Sourced from SOCIAL_LINKS (src/lib/social-links.ts, OPE-171) so the footer
// links and this sameAs never diverge. Today that's Facebook only —
//   Facebook: real MMATF page (verified 2026-05-12 — og:title "Meet Me at
//     the Fair", og:description matches site description). Knowledge Graph
//     reciprocity loop closed 2026-05-12 — FB Page Website field points at
//     meetmeatthefair.com (#140).
//   Instagram: the @meetmeatthefair handle belongs to a different person;
//     MMATF does not yet have a business Instagram (OPE-171). Adding a real
//     account to SOCIAL_LINKS later surfaces it here automatically.
//   X/Twitter: none yet.
const SAME_AS = SOCIAL_LINKS.map((s) => s.href);

export function OrganizationSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://meetmeatthefair.com/#organization",
    name: "Meet Me at the Fair",
    alternateName: "MMATF",
    url: "https://meetmeatthefair.com",
    description:
      "Vendor-first event directory for fairs, festivals, craft shows, and home shows across New England.",
    logo: {
      "@type": "ImageObject",
      url: LOGO_URL,
    },
    areaServed: [
      { "@type": "State", name: "Maine" },
      { "@type": "State", name: "New Hampshire" },
      { "@type": "State", name: "Vermont" },
      { "@type": "State", name: "Massachusetts" },
      { "@type": "State", name: "Connecticut" },
      { "@type": "State", name: "Rhode Island" },
    ],
    sameAs: SAME_AS,
    contactPoint: {
      "@type": "ContactPoint",
      email: "hello@meetmeatthefair.com",
      contactType: "customer service",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
