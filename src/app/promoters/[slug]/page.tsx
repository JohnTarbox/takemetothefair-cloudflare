/**
 * Public promoter page — listing of all events the promoter has hosted (or
 * is hosting), with their contact / website info and an upcoming-vs-past
 * split.
 *
 * Why this page exists now (round 6 / R5 list item 4.3):
 *  - The admin "view" link at /admin/promoters → /promoters/{slug} 404'd.
 *  - Promoters were absent from sitemap, so search engines couldn't find them.
 *  - IndexNow lifecycle hooks couldn't fire on a non-existent surface.
 *  - The "promoter featured listing" revenue stream had no surface.
 *
 * Pattern matches venue page (src/app/venues/[slug]/page.tsx) — same SEO
 * scaffolding (BreadcrumbSchema, OG metadata, ScrollDepthTracker) and same
 * EventList component for the events grid.
 *
 * No "ACTIVE" filter on promoters table (unlike venues which have status):
 * the promoters schema has no status column, just `verified` (which is a
 * trust badge, not a public/private gate). All promoters get a public page.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { MapPin, Phone, Mail, Globe, Calendar, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EventList } from "@/components/events/event-list";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, venues } from "@/lib/db/schema";
import { eq, and, lt } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { logError } from "@/lib/logger";
import type { Metadata } from "next";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { ItemListSchema } from "@/components/seo/ItemListSchema";
import { ScrollDepthTracker } from "@/components/ScrollDepthTracker";
import { unsafeSlug } from "@/lib/utils";
import { cdnImage, OG_EVENT } from "@/lib/cdn-image";

export const revalidate = 300; // 5-minute ISR

interface Props {
  params: Promise<{ slug: string }>;
}

async function getPromoter(slug: string) {
  const db = getCloudflareDb();

  try {
    const promoterResults = await db
      .select()
      .from(promoters)
      .where(eq(promoters.slug, unsafeSlug(slug)))
      .limit(1);

    if (promoterResults.length === 0) return null;

    const promoter = promoterResults[0];
    const now = new Date();

    // Two passes: upcoming first (priority), then past (recent first, capped).
    // Mirrors the structure of venue's events list. Narrow projection —
    // D1 100-col result-row cap; see eventJoinProjection.
    const upcomingResults = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(
        // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
        and(eq(events.promoterId, promoter.id), isPublicEventStatus(), upcomingEndPredicate(now))
      )
      .orderBy(events.startDate)
      .limit(12);

    const pastResults = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(
        and(eq(events.promoterId, promoter.id), isPublicEventStatus(), lt(events.endDate, now))
      )
      .orderBy(events.startDate)
      .limit(12);

    // Cast lite projection back to schema row types for EventList's
    // prop contract; see eventJoinProjection's docblock for the audit.
    // Parameter type derived from the result array so it stays in sync
    // with the projection automatically.
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    type EventRow = (typeof upcomingResults)[number];
    const mapEvent = (r: EventRow) => ({
      ...r.events,
      venue: r.venue as FullVenue,
      promoter: r.promoter as FullPromoter,
    });

    // Cohort 7 follow-up (2026-06-01) — attach event_days so EventCard's
    // date badge shows the next occurrence. Two batches because the
    // upcoming + past lists are independent.
    const upcomingFlat = upcomingResults.map(mapEvent);
    const pastFlat = pastResults.map(mapEvent);
    const [upcomingEvents, pastEvents] = await Promise.all([
      attachEventDayDates(db, upcomingFlat),
      attachEventDayDates(db, pastFlat),
    ]);

    return {
      ...promoter,
      upcomingEvents,
      pastEvents,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching promoter",
      error: e,
      source: "app/promoters/[slug]/page.tsx:getPromoter",
      context: { slug },
    });
    // REL1' §1 (2026-06-04): throw FetchError on query failure so error.tsx
    // renders (transient outage) instead of notFound() (permanent 404).
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/promoters/[slug]/page.tsx:getPromoter", e);
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const promoter = await getPromoter(slug);

  if (!promoter) {
    return { title: "Promoter Not Found" };
  }

  const title = `${promoter.companyName} | Meet Me at the Fair`;
  // Description: prefer the promoter's own description; fall back to a
  // location- and event-count-derived sentence so the meta isn't empty.
  // Mirrors the round-2 fallback chain pattern from venue/vendor pages.
  const eventCount = promoter.upcomingEvents.length + promoter.pastEvents.length;
  const locationStr = [promoter.city, promoter.state].filter(Boolean).join(", ");
  const description =
    promoter.description ??
    `${promoter.companyName}${locationStr ? ` in ${locationStr}` : ""} hosts ${eventCount > 0 ? `${eventCount} event${eventCount === 1 ? "" : "s"}` : "events"} on Meet Me at the Fair. Browse upcoming and past events, contact the organizer, and discover their work.`;
  const url = `https://meetmeatthefair.com/promoters/${promoter.slug}`;

  // IMG1 (2026-06-07) — landscape (1200×630) variant matches the existing
  // declared OG dims. Promoter logos that happen to be square will be
  // letterboxed (fit=cover would chop them); accepting that trade-off
  // to stay consistent with the original declaration. If a square OG
  // variant for promoters is desired later, mirror the vendor split
  // (logoUrl → OG_SQUARE, fallback → OG_EVENT).
  const og = cdnImage(promoter.logoUrl ?? "https://meetmeatthefair.com/og-default.png", OG_EVENT);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: promoter.companyName,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      images: [{ url: og, width: 1200, height: 630, alt: promoter.companyName }],
    },
    twitter: {
      card: "summary_large_image",
      title: promoter.companyName,
      description,
      images: [og],
    },
  };
}

export default async function PromoterDetailPage({ params }: Props) {
  const { slug } = await params;
  const promoter = await getPromoter(slug);

  if (!promoter) {
    notFound();
  }

  const locationStr = [promoter.city, promoter.state].filter(Boolean).join(", ");

  return (
    <>
      <ScrollDepthTracker pageType="promoter-detail" />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Promoters", url: "https://meetmeatthefair.com/promoters" },
          {
            name: promoter.companyName,
            url: `https://meetmeatthefair.com/promoters/${promoter.slug}`,
          },
        ]}
      />
      {promoter.upcomingEvents.length > 0 && (
        <ItemListSchema
          name={`Upcoming events from ${promoter.companyName}`}
          description={`Events organized by ${promoter.companyName}`}
          items={promoter.upcomingEvents.map((e) => ({
            name: e.name,
            url: `https://meetmeatthefair.com/events/${e.slug}`,
            image: e.imageUrl,
          }))}
          pageUrl={`https://meetmeatthefair.com/promoters/${promoter.slug}`}
        />
      )}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <main className="lg:col-span-2 space-y-6">
            <div className="flex items-start gap-4">
              {promoter.logoUrl && (
                <div className="w-24 h-24 rounded-lg overflow-hidden bg-muted border border-border relative shrink-0">
                  <Image
                    src={promoter.logoUrl}
                    alt={`${promoter.companyName} logo`}
                    fill
                    sizes="96px"
                    className="object-contain"
                  />
                </div>
              )}
              <div>
                <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-2 flex-wrap">
                  {promoter.companyName}
                  {promoter.verified && (
                    <Badge variant="info" className="text-xs">
                      <ShieldCheck className="w-3 h-3 mr-1 inline" />
                      Verified
                    </Badge>
                  )}
                </h1>
                {locationStr && (
                  <p className="mt-2 text-lg text-muted-foreground flex items-center gap-2">
                    <MapPin className="w-5 h-5" />
                    {locationStr}
                  </p>
                )}
              </div>
            </div>

            {promoter.description && (
              <div className="prose prose-gray max-w-none">
                <p className="text-muted-foreground whitespace-pre-wrap">{promoter.description}</p>
              </div>
            )}

            {promoter.upcomingEvents.length > 0 && (
              <section>
                <h2 className="text-2xl font-semibold text-foreground mb-4 flex items-center gap-2">
                  <Calendar className="w-6 h-6" />
                  Upcoming events
                </h2>
                <EventList events={promoter.upcomingEvents} />
              </section>
            )}

            {promoter.pastEvents.length > 0 && (
              <section>
                <h2 className="text-2xl font-semibold text-foreground mb-4">Past events</h2>
                <EventList events={promoter.pastEvents} />
              </section>
            )}

            {promoter.upcomingEvents.length === 0 && promoter.pastEvents.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No public events recorded for this promoter yet.
                </CardContent>
              </Card>
            )}
          </main>

          <aside className="space-y-4">
            <Card>
              <CardContent className="py-6 space-y-3">
                <h2 className="text-lg font-semibold text-foreground">Contact</h2>
                {promoter.website && (
                  <p className="flex items-center gap-2 text-sm">
                    <Globe className="w-4 h-4 text-muted-foreground" />
                    <Link
                      href={promoter.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-navy hover:underline break-all"
                    >
                      {promoter.website.replace(/^https?:\/\//, "")}
                    </Link>
                  </p>
                )}
                {promoter.contactEmail && (
                  <p className="flex items-center gap-2 text-sm">
                    <Mail className="w-4 h-4 text-muted-foreground" />
                    <a
                      href={`mailto:${promoter.contactEmail}`}
                      className="text-navy hover:underline break-all"
                    >
                      {promoter.contactEmail}
                    </a>
                  </p>
                )}
                {promoter.contactPhone && (
                  <p className="flex items-center gap-2 text-sm">
                    <Phone className="w-4 h-4 text-muted-foreground" />
                    <a href={`tel:${promoter.contactPhone}`} className="text-navy hover:underline">
                      {promoter.contactPhone}
                    </a>
                  </p>
                )}
                {!promoter.website && !promoter.contactEmail && !promoter.contactPhone && (
                  <p className="text-sm text-muted-foreground">No contact info on file.</p>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </>
  );
}
