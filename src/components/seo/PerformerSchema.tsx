/**
 * OPE-115 §6.2 — Person / PerformingGroup / MusicGroup JSON-LD for the public
 * performer page. Emits name, url (canonical), sameAs (official site), image,
 * and `performerIn` — the events this act performs at (internal-link equity).
 * Reuses the same @type mapping as the Event-node `performer` emission (OPE-114).
 */
import { performerSchemaType } from "@/lib/performers/event-jsonld";
import {
  buildPerformerInEvents,
  type PerformerInEventInput,
} from "@/lib/performers/performer-in-jsonld";

export interface PerformerSchemaProps {
  name: string;
  slug: string;
  performerType: "PERSON" | "GROUP" | null;
  actCategory: string | null;
  sameAs?: string | null;
  imageUrl?: string | null;
  /**
   * Events this performer appears at (confirmed), for `performerIn`.
   *
   * OPE-263: this now carries `venue` + `stateCode`. It previously took only
   * name/slug/startDate, which made a missing `location` unavoidable at this
   * layer — the page already had the venue and was dropping it in its map.
   */
  events: PerformerInEventInput[];
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
  const performerIn = buildPerformerInEvents(events, siteUrl);
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": performerSchemaType(performerType, actCategory),
    name,
    url: `${siteUrl}/performers/${slug}`,
    ...(sameAs ? { sameAs } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    // OPE-263 — built by a pure, CI-guarded builder. Each node carries a real
    // `location`; events with no derivable startDate are dropped rather than
    // emitted invalid, so this array can be shorter than `events` (or empty,
    // in which case performerIn is omitted entirely).
    ...(performerIn.length > 0 ? { performerIn } : {}),
  };

  // Same JSON-LD emission pattern as EventSchema/BreadcrumbSchema (admin-entered
  // performer data, conditional spreads → no undefined). Escape `<` so a stray
  // "</script>" in a name can't break out of the tag (defensive; the sibling
  // schema components predate this hardening).
  const json = JSON.stringify(schema).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
