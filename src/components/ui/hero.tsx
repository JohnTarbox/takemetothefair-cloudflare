/**
 * Hero primitive — design system keystone PR 2 (2026-06-07).
 *
 * Page-hero wrapper for entity-detail pages (event / vendor / venue).
 * Per `MMATF-UIUX-EventDetail-Spec.md` §1, the hero must never render
 * a blank gray void: 3-tier fallback (image → map → category banner)
 * exists today as the inline hero block at `src/app/events/[slug]/page.tsx`
 * (shipped in PR #336 / UX-A1). This primitive lifts that pattern into
 * the design system so vendor + venue + future entity heroes share
 * the same surface, and so UX-A1 Phase 2 (smart-crop via IMG1's
 * `cdnImage`) can land as a Hero-variant prop swap rather than a
 * per-page rewrite.
 *
 * Variants:
 *   - `image` — wraps a `<Image src=...>` from next/image. Caller is
 *     responsible for the URL transform (e.g. `cdnImage(src, HERO_DESKTOP)`).
 *     The Hero primitive itself stays IMG1-agnostic so it can ship in
 *     PR 2 independently of whether IMG1 (PR #375) has merged.
 *   - `map` — location-anchored hero band. Renders an inline map
 *     placeholder + the entity name + a "View on Map" link. (Map tile
 *     embedding is deliberately deferred — keeping it edge-renderable
 *     without bundle bloat. The fallback is a styled location card.)
 *   - `category-banner` — branded banner using the event/entity's
 *     category color + glyph (per UX-A1 §1 Tier 3 fallback). Consumes
 *     a `CategoryAccent` name from the Chip primitive's vocabulary.
 *
 * Why a primitive rather than inline JSX:
 *   - PR 3's event-detail sweep replaces the inline hero block with
 *     `<Hero variant=... />`. One refactor in one PR.
 *   - UX-A1 Phase 2 wires smart-crop by adding a `smartCrop` prop +
 *     calling `cdnImage(src, HERO_DESKTOP)` internally. No per-page diff.
 *   - Vendor + venue heroes (which today have no fallback at all) get
 *     the 3-tier behavior for free once they adopt the primitive.
 */

import Image from "next/image";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryAccent } from "./chip";

type HeroBase = {
  /** Display title overlaid on the hero. */
  title: string;
  /** Subtitle / next-occurrence / venue line shown under the title. */
  subtitle?: string;
  className?: string;
};

export type HeroProps =
  | (HeroBase & {
      variant: "image";
      /** Full image URL. For IMG1-aware callers, pass `cdnImage(src, HERO_DESKTOP)`. */
      src: string;
      /** Alt text for the hero image. */
      alt: string;
    })
  | (HeroBase & {
      variant: "map";
      /** City + state line shown on the map placeholder. */
      locationLabel: string;
      /** Link target for the "View on Map" CTA. */
      mapHref?: string;
    })
  | (HeroBase & {
      variant: "category-banner";
      /** Category accent name from globals.css's --accent-* set. */
      accentName: CategoryAccent;
      /** Lucide icon (or any node) shown center-left. */
      glyph?: React.ReactNode;
    });

const ASPECT = "aspect-[16/9] md:aspect-[2/1] relative w-full overflow-hidden";

function HeroOverlay({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-end p-6 md:p-8 bg-gradient-to-t from-foreground/70 to-transparent text-background">
      <h1 className="text-2xl md:text-4xl font-semibold">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm md:text-base opacity-90">{subtitle}</p> : null}
    </div>
  );
}

export function Hero(props: HeroProps) {
  const { className } = props;

  if (props.variant === "image") {
    return (
      <div className={cn(ASPECT, className)}>
        <Image
          src={props.src}
          alt={props.alt}
          fill
          priority
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 100vw, 1200px"
          className="object-cover"
        />
        <HeroOverlay title={props.title} subtitle={props.subtitle} />
      </div>
    );
  }

  if (props.variant === "map") {
    return (
      <div className={cn(ASPECT, "bg-muted", className)}>
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
          <MapPin className="w-12 h-12 md:w-16 md:h-16 text-muted-foreground mb-3" aria-hidden />
          <p className="text-sm md:text-base text-muted-foreground">{props.locationLabel}</p>
          {props.mapHref ? (
            <Link
              href={props.mapHref}
              className="mt-3 text-sm font-medium text-ring hover:underline"
            >
              View on Map →
            </Link>
          ) : null}
        </div>
        <HeroOverlay title={props.title} subtitle={props.subtitle} />
      </div>
    );
  }

  // category-banner
  const ACCENT_BG: Record<CategoryAccent, string> = {
    gold: "bg-accent-gold",
    terracotta: "bg-accent-terracotta",
    sage: "bg-accent-sage",
    "navy-soft": "bg-accent-navy-soft",
    stone: "bg-accent-stone",
  };
  return (
    <div className={cn(ASPECT, ACCENT_BG[props.accentName], className)}>
      <div className="absolute inset-0 flex items-center justify-center">
        {props.glyph ? (
          <div className="text-background opacity-50 w-24 h-24 md:w-32 md:h-32">{props.glyph}</div>
        ) : null}
      </div>
      <HeroOverlay title={props.title} subtitle={props.subtitle} />
    </div>
  );
}
