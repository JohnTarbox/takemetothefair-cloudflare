// Scraper registry — single lookup point for all scraper sources

import type { ScraperEntry, ScrapedEvent } from "./types";
import { scrapeMaineFairs, scrapeEventDetails as scrapeMaineFairsDetails } from "./mainefairs";
import { scrapeVtFairs, scrapeNhFairs, scrapeVtNhEventDetails } from "./vtnhfairs";
import { scrapeMafaFairs, scrapeMafaEventDetails } from "./mafa";
import { scrapeMainePublic, scrapeMainePublicEventDetails } from "./mainepublic";
import { scrapeMaineMade, scrapeMaineMadeEventDetails } from "./mainemade";
import {
  scrapeNewEnglandCraftFairs,
  scrapeNewEnglandCraftFairsEventDetails,
} from "./newenglandcraftfairs";
import { scrapeJoycesCraftShows, scrapeJoycesCraftShowsEventDetails } from "./joycescraftshows";
import {
  scrapeFairsAndFestivals,
  scrapeFairsAndFestivalsUrl,
  scrapeEventDetails as scrapeFairsAndFestivalsEventDetails,
} from "./fairsandfestivals";

const registry: Record<string, ScraperEntry> = {
  "mainefairs.net": {
    scrape: () => scrapeMaineFairs(),
    scrapeDetails: (url) => scrapeMaineFairsDetails(url),
    // OPE-483 — the site was rebuilt and this scraper is dead at BOTH ends,
    // verified 2026-08-25 with curl:
    //   https://mainefairs.net/fairs/fair-calendar/  → 404  (its CALENDAR_URL)
    //   https://mainefairs.net/event/<slug>/         → 404  (all 35 stored URLs)
    // The root still 200s, and the fair list is now a JS-rendered directory at
    // /maine-fairs/ that serves no per-fair pages, so the Tribe-Events anchors
    // this scraper parses no longer exist anywhere on the site.
    //
    // Re-pointing it needs a rewrite against the new markup, not a URL swap —
    // filed as follow-up rather than guessed at here.
    retired: {
      since: "2026-08-25",
      reason:
        "site rebuilt; /fairs/fair-calendar/ and /event/<slug>/ both 404, no per-fair pages on the replacement /maine-fairs/ directory",
    },
  },
  "mafa.org": {
    scrape: () => scrapeMafaFairs(),
    scrapeDetails: (url) => scrapeMafaEventDetails(url),
  },
  "vtnhfairs.org": {
    scrape: () => scrapeVtFairs(),
    scrapeDetails: (url) => scrapeVtNhEventDetails(url),
  },
  "vtnhfairs.org-vt": {
    scrape: () => scrapeVtFairs(),
    scrapeDetails: (url) => scrapeVtNhEventDetails(url),
  },
  "vtnhfairs.org-nh": {
    scrape: () => scrapeNhFairs(),
    scrapeDetails: (url) => scrapeVtNhEventDetails(url),
  },
  "mainepublic.org": {
    scrape: () => scrapeMainePublic(),
    scrapeDetails: (url) => scrapeMainePublicEventDetails(url),
  },
  "mainemade.com": {
    scrape: () => scrapeMaineMade(),
    scrapeDetails: (url) => scrapeMaineMadeEventDetails(url),
  },
  "newenglandcraftfairs.com": {
    scrape: () => scrapeNewEnglandCraftFairs(),
    scrapeDetails: (url) => scrapeNewEnglandCraftFairsEventDetails(url),
  },
  "joycescraftshows.com": {
    scrape: () => scrapeJoycesCraftShows(),
    scrapeDetails: (url) => scrapeJoycesCraftShowsEventDetails(url),
  },
};

/**
 * Get a scraper entry by source key.
 * Exact match first, then falls back to startsWith("fairsandfestivals.net").
 */
export function getScraper(source: string): ScraperEntry | undefined {
  if (registry[source]) return registry[source];

  // fairsandfestivals.net handles multiple sub-sources
  if (source.startsWith("fairsandfestivals.net")) {
    return {
      scrape: (options) => {
        if (options?.customUrl) {
          return scrapeFairsAndFestivalsUrl(options.customUrl);
        }
        const stateCode = options?.stateCode || "ME";
        return scrapeFairsAndFestivals(stateCode);
      },
      scrapeDetails: (url) => scrapeFairsAndFestivalsEventDetails(url),
    };
  }

  return undefined;
}

/**
 * Parse source string into options for the scraper.
 * e.g. "fairsandfestivals.net-ME" → { stateCode: "ME" }
 * e.g. "fairsandfestivals.net-custom" + customUrl → { customUrl }
 */
export function parseSourceOptions(
  source: string,
  customUrl?: string | null
): { stateCode?: string; customUrl?: string } {
  if (source === "fairsandfestivals.net-custom" && customUrl) {
    return { customUrl };
  }

  const stateMatch = source.match(/fairsandfestivals\.net-([A-Z]{2})/i);
  if (stateMatch) {
    return { stateCode: stateMatch[1].toUpperCase() };
  }

  return {};
}

/**
 * Get the details scraper function for a given sourceName.
 * Used in POST import and PATCH sync where we match on event.sourceName.
 */
export function getDetailsScraper(
  sourceName: string | null | undefined
): ((url: string) => Promise<Partial<ScrapedEvent>>) | undefined {
  if (!sourceName) return undefined;

  const entry = getScraper(sourceName);
  return entry?.scrapeDetails;
}

/**
 * OPE-483 — the retirement record for a source, or undefined if it is live.
 *
 * Deliberately separate from `getDetailsScraper` rather than making that return
 * undefined for a retired entry: callers need to tell "this source is dead, and
 * here is when we checked" apart from "I do not recognise this label". The first
 * is a finding; the second is usually a typo. Collapsing them is what let
 * mainefairs.net go seven months without a sync while the run reported success.
 */
export function getScraperRetirement(
  sourceName: string | null | undefined
): { since: string; reason: string } | undefined {
  if (!sourceName) return undefined;
  return getScraper(sourceName)?.retired;
}
