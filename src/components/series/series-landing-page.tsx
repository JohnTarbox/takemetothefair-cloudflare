/**
 * EH3 P2.3a — series landing page UI.
 *
 * Renders a series hub: the series name/description, an "Upcoming" section
 * (current/ongoing occurrences) and a "Past years" history, plus the
 * EventSeries JSON-LD. Occurrence links use the Option-A `/events/<series>/<year>`
 * path (the [slug]/[year] route ships in P2.3b, before any series is live).
 *
 * Pure presentation over the data from getSeriesLanding; the partition/hero logic
 * is the unit-tested occurrence-view module.
 */
import Link from "next/link";
import {
  partitionOccurrences,
  pickHeroOccurrence,
  toSchemaOccurrences,
} from "@/lib/series/occurrence-view";
import { buildEventSeriesJsonLd } from "@/lib/series/series-schema-org";
import type { SeriesLanding, LandingOccurrence } from "@/lib/series/get-series-landing";
import { formatDateRange } from "@/lib/utils";
import { cdnImage } from "@/lib/cdn-image";

const HERO_WIDTHS = [400, 800, 1200, 1600];

function venueLabel(o: LandingOccurrence): string {
  return [o.venue?.city, o.venue?.state].filter(Boolean).join(", ");
}

export function SeriesLandingPage({ landing, now }: { landing: SeriesLanding; now: Date }) {
  const { series, occurrences } = landing;
  // OPE-27 — effective series image (already resolved in getSeriesLanding to fall
  // back to the hero occurrence when the series row has none).
  const heroImage = series.imageUrl;
  const { current, past } = partitionOccurrences(occurrences, now);
  const byId = new Map(occurrences.map((o) => [o.id, o]));

  // K46 — the hero occurrence (next/current, else most recent) supplies the
  // series-level `location` + `startDate`/`endDate`. Every subEvent carries its
  // own venue, but the EventSeries node itself needs a representative one.
  const hero = pickHeroOccurrence(occurrences, now);
  const jsonLd = buildEventSeriesJsonLd(
    {
      canonicalSlug: series.canonicalSlug,
      name: series.name,
      description: series.description,
      imageUrl: series.imageUrl,
      venue: hero?.venue ?? null,
      startDateIso: hero?.startDate ? hero.startDate.toISOString().slice(0, 10) : null,
      endDateIso: hero?.endDate ? hero.endDate.toISOString().slice(0, 10) : null,
    },
    toSchemaOccurrences(occurrences)
  );

  // Relative Option-A occurrence path (year page, or the event slug when undated).
  const occPath = (year: number | null, slug: string) =>
    year === null ? `/events/${slug}` : `/events/${series.canonicalSlug}/${year}`;

  const renderRow = (v: { id: string; year: number | null }) => {
    const o = byId.get(v.id);
    if (!o) return null;
    const loc = venueLabel(o);
    return (
      <li key={v.id}>
        <Link
          href={occPath(v.year, o.slug)}
          className="flex items-baseline justify-between gap-4 border-b border-secondary/15 py-3 hover:text-terracotta"
        >
          <span className="font-display font-semibold text-secondary">
            {v.year ?? o.name}
            {v.year ? (
              <span className="ml-2 font-sans text-sm font-normal opacity-70">{o.name}</span>
            ) : null}
          </span>
          <span className="whitespace-nowrap text-sm opacity-70">
            {formatDateRange(o.startDate, o.endDate)}
            {loc ? ` · ${loc}` : ""}
          </span>
        </Link>
      </li>
    );
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <script
        type="application/ld+json"
        // Escape `<` so a series name/description containing `</script>` can't
        // break out of the JSON-LD block (defense beyond EventSchema's plain
        // stringify; series text is first-party but cheap to harden).
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />

      <header className="mb-8">
        {heroImage ? (
          // OPE-27 — series hero, inherited from the hero occurrence when the
          // series row has no image. Above the fold ⇒ eager + fetchpriority high;
          // the aspect-ratio box reserves layout so there's no CLS.
          <div className="mb-5 aspect-[16/9] overflow-hidden rounded-xl bg-secondary/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={cdnImage(heroImage, {
                width: 1200,
                height: 675,
                fit: "cover",
                gravity: "auto",
                format: "auto",
                quality: 80,
                onerror: "redirect",
              })}
              srcSet={HERO_WIDTHS.map(
                (w) =>
                  `${cdnImage(heroImage, {
                    width: w,
                    height: Math.round((w * 9) / 16),
                    fit: "cover",
                    gravity: "auto",
                    format: "auto",
                    quality: 80,
                    onerror: "redirect",
                  })} ${w}w`
              ).join(", ")}
              sizes="(max-width: 768px) 100vw, 768px"
              width={1200}
              height={675}
              alt={series.name}
              fetchPriority="high"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}
        <div className="text-xs font-bold uppercase tracking-[0.16em] text-terracotta">
          Event series
        </div>
        <h1 className="mt-1 font-display text-3xl font-bold text-secondary">{series.name}</h1>
        {series.description ? <p className="mt-3 text-secondary/80">{series.description}</p> : null}
      </header>

      {current.length > 0 ? (
        <section className="mb-10">
          <h2 className="mb-2 font-display text-lg font-semibold text-secondary">Upcoming</h2>
          <ul>{current.map(renderRow)}</ul>
        </section>
      ) : null}

      {past.length > 0 ? (
        <section>
          <h2 className="mb-2 font-display text-lg font-semibold text-secondary">Past years</h2>
          <ul>{past.map(renderRow)}</ul>
        </section>
      ) : null}

      {current.length === 0 && past.length === 0 ? (
        <p className="text-secondary/70">No published occurrences yet.</p>
      ) : null}
    </main>
  );
}
