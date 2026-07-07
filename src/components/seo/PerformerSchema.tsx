/**
 * OPE-115 §6.2 — Person / PerformingGroup / MusicGroup JSON-LD for the public
 * performer page. Emits name, url (canonical), sameAs (official site), image,
 * and `performerIn` — the events this act performs at (internal-link equity).
 * Reuses the same @type mapping as the Event-node `performer` emission (OPE-114).
 */
import { performerSchemaType } from "@/lib/performers/event-jsonld";

export interface PerformerSchemaProps {
  name: string;
  slug: string;
  performerType: "PERSON" | "GROUP" | null;
  actCategory: string | null;
  sameAs?: string | null;
  imageUrl?: string | null;
  /** Events this performer appears at (confirmed), for `performerIn`. */
  events: Array<{ name: string; slug: string; startDate?: Date | null }>;
}

export function PerformerSchema({
  name,
  slug,
  performerType,
  actCategory,
  sameAs,
  imageUrl,
  events,
}: PerformerSchemaProps) {
  const siteUrl = "https://meetmeatthefair.com";
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": performerSchemaType(performerType, actCategory),
    name,
    url: `${siteUrl}/performers/${slug}`,
    ...(sameAs ? { sameAs } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    ...(events.length > 0
      ? {
          performerIn: events.map((e) => ({
            "@type": "Event",
            name: e.name,
            url: `${siteUrl}/events/${e.slug}`,
            ...(e.startDate ? { startDate: new Date(e.startDate).toISOString() } : {}),
          })),
        }
      : {}),
  };

  // Same JSON-LD emission pattern as EventSchema/BreadcrumbSchema (admin-entered
  // performer data, conditional spreads → no undefined). Escape `<` so a stray
  // "</script>" in a name can't break out of the tag (defensive; the sibling
  // schema components predate this hardening).
  const json = JSON.stringify(schema).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
