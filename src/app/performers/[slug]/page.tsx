/**
 * OPE-115 — public performer page `/performers/{slug}` (PLURAL per the URL-scheme
 * rule). Bio + image + website/social + category/home base + Upcoming/Past
 * appearances (the "Mr. Drew appears at these fairs" cross-event view). Emits
 * Person/PerformingGroup/MusicGroup JSON-LD (PerformerSchema). Slug renames 301
 * via performer_slug_history in src/middleware.ts. Mirrors the promoter page.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Music, MapPin, Globe, ShieldCheck, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EventList } from "@/components/events/event-list";
import { getCloudflareDb } from "@/lib/cloudflare";
import { performers, eventPerformers, events, venues, promoters } from "@/lib/db/schema";
import { eq, and, lt } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { attachEventDayDates } from "@/lib/event-days-attach";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { logError } from "@/lib/logger";
import type { Metadata } from "next";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { PerformerSchema } from "@/components/seo/PerformerSchema";
import { ScrollDepthTracker } from "@/components/ScrollDepthTracker";
import { unsafeSlug } from "@/lib/utils";
import { cdnImage, OG_EVENT } from "@/lib/cdn-image";

export const revalidate = 300; // 5-minute ISR

interface Props {
  params: Promise<{ slug: string }>;
}

const CATEGORY_LABEL: Record<string, string> = {
  MUSIC: "Music",
  ANIMAL_SHOW: "Animal show",
  MAGIC: "Magic",
  COMEDY: "Comedy",
  CIRCUS: "Circus",
  DANCE: "Dance",
  THEATER: "Theater",
  EDUCATIONAL: "Educational",
  CHILDRENS: "Children's",
  DEMONSTRATION: "Demonstration",
  OTHER: "Entertainment",
};

async function getPerformer(slug: string) {
  const db = getCloudflareDb();
  try {
    const rows = await db
      .select()
      .from(performers)
      .where(eq(performers.slug, unsafeSlug(slug)))
      .limit(1);
    if (rows.length === 0 || rows[0].deletedAt != null) return null;
    const performer = rows[0];
    const now = new Date();

    // Events this act performs at (CONFIRMED only), via event_performers. A
    // performer can have multiple sets at one event → dedupe by event id.
    const loadEvents = async (upcoming: boolean) => {
      const raw = await db
        .select(eventJoinProjection)
        .from(events)
        .innerJoin(eventPerformers, eq(eventPerformers.eventId, events.id))
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(
          and(
            eq(eventPerformers.performerId, performer.id),
            eq(eventPerformers.status, "CONFIRMED"),
            isPublicEventStatus(),
            upcoming ? upcomingEndPredicate(now) : lt(events.endDate, now)
          )
        )
        .orderBy(events.startDate)
        .limit(50);
      type FullVenue = typeof venues.$inferSelect;
      type FullPromoter = typeof promoters.$inferSelect;
      const seen = new Set<string>();
      const deduped = raw.filter((r) => {
        if (seen.has(r.events.id)) return false;
        seen.add(r.events.id);
        return true;
      });
      const flat = deduped.map((r) => ({
        ...r.events,
        venue: r.venue as FullVenue,
        promoter: r.promoter as FullPromoter,
      }));
      return attachEventDayDates(db, flat);
    };

    const [upcomingEvents, pastEvents] = await Promise.all([loadEvents(true), loadEvents(false)]);
    return { ...performer, upcomingEvents, pastEvents: pastEvents.slice(0, 12) };
  } catch (e) {
    await logError(db, {
      message: "Error fetching performer",
      error: e,
      source: "app/performers/[slug]/page.tsx:getPerformer",
      context: { slug },
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/performers/[slug]/page.tsx:getPerformer", e);
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const performer = await getPerformer(slug);
  if (!performer) return { title: "Performer Not Found" };

  const category = performer.actCategory ? CATEGORY_LABEL[performer.actCategory] : null;
  const homeBase = [performer.homeBaseCity, performer.homeBaseState].filter(Boolean).join(", ");
  const title = `${performer.name} | Meet Me at the Fair`;
  const description =
    performer.description?.trim() ||
    `${performer.name}${category ? ` — ${category}` : ""}${homeBase ? ` from ${homeBase}` : ""}. See upcoming fair & festival appearances.`;
  const url = `https://meetmeatthefair.com/performers/${performer.slug}`;
  const og = cdnImage(performer.imageUrl ?? "https://meetmeatthefair.com/og-default.png", OG_EVENT);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: performer.name,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      images: [{ url: og, width: 1200, height: 630, alt: performer.name }],
    },
    twitter: { card: "summary_large_image", title: performer.name, description, images: [og] },
  };
}

export default async function PerformerDetailPage({ params }: Props) {
  const { slug } = await params;
  const performer = await getPerformer(slug);
  if (!performer) notFound();

  const category = performer.actCategory ? CATEGORY_LABEL[performer.actCategory] : null;
  const homeBase = [performer.homeBaseCity, performer.homeBaseState].filter(Boolean).join(", ");
  const schemaEvents = [...performer.upcomingEvents, ...performer.pastEvents].map((e) => ({
    name: e.name,
    slug: e.slug,
    startDate: e.startDate,
  }));

  return (
    <>
      <ScrollDepthTracker pageType="performer-detail" />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          {
            name: performer.name,
            url: `https://meetmeatthefair.com/performers/${performer.slug}`,
          },
        ]}
      />
      <PerformerSchema
        name={performer.name}
        slug={performer.slug}
        performerType={performer.performerType as "PERSON" | "GROUP" | null}
        actCategory={performer.actCategory}
        sameAs={performer.website}
        imageUrl={performer.imageUrl}
        events={schemaEvents}
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <main className="lg:col-span-2 space-y-6">
            <div className="flex items-start gap-4">
              {performer.imageUrl ? (
                <div className="w-24 h-24 rounded-full overflow-hidden bg-muted border border-border relative shrink-0">
                  <Image
                    src={performer.imageUrl}
                    alt={performer.name}
                    fill
                    sizes="96px"
                    className="object-cover"
                  />
                </div>
              ) : (
                <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Music className="w-10 h-10 text-muted-foreground" />
                </div>
              )}
              <div>
                <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-2 flex-wrap">
                  {performer.name}
                  {performer.verified && (
                    <Badge variant="info" className="text-xs">
                      <ShieldCheck className="w-3 h-3 mr-1 inline" />
                      Verified
                    </Badge>
                  )}
                </h1>
                <p className="mt-2 text-lg text-muted-foreground flex items-center gap-3 flex-wrap">
                  {category && <span>{category}</span>}
                  {homeBase && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-4 h-4" />
                      {homeBase}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {performer.description && (
              <div className="prose prose-gray max-w-none">
                <p className="text-muted-foreground whitespace-pre-wrap">{performer.description}</p>
              </div>
            )}

            {performer.upcomingEvents.length > 0 && (
              <section>
                <h2 className="text-2xl font-semibold text-foreground mb-4 flex items-center gap-2">
                  <Calendar className="w-6 h-6" />
                  Upcoming appearances
                </h2>
                <EventList events={performer.upcomingEvents} />
              </section>
            )}

            {performer.pastEvents.length > 0 && (
              <section>
                <h2 className="text-2xl font-semibold text-foreground mb-4">Past appearances</h2>
                <EventList events={performer.pastEvents} />
              </section>
            )}

            {performer.upcomingEvents.length === 0 && performer.pastEvents.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No public appearances recorded for this act yet.
                </CardContent>
              </Card>
            )}
          </main>

          <aside className="space-y-4">
            <Card>
              <CardContent className="py-6 space-y-3">
                <h2 className="text-lg font-semibold text-foreground">Links</h2>
                {performer.website ? (
                  <p className="flex items-center gap-2 text-sm">
                    <Globe className="w-4 h-4 text-muted-foreground" />
                    <Link
                      href={performer.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-navy hover:underline break-all"
                    >
                      {performer.website.replace(/^https?:\/\//, "")}
                    </Link>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No website on file.</p>
                )}
              </CardContent>
            </Card>

            {!performer.claimed && (
              // OPE-115 — claim CTA for unclaimed acts. The claim FLOW lands in
              // Phase 4 (OPE-116); for now this is an informational prompt.
              <Card>
                <CardContent className="py-6 space-y-2">
                  <h2 className="text-lg font-semibold text-foreground">Are you this act?</h2>
                  <p className="text-sm text-muted-foreground">
                    Claim this profile to manage your bio, photo, and appearance schedule. Claiming
                    opens soon — check back shortly.
                  </p>
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}
