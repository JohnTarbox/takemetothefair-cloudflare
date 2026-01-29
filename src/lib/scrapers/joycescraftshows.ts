// Scraper for joycescraftshows.com
// Wix-based site, all content client-rendered - using hardcoded event list

import type { ScrapedEvent, ScrapeResult, ScrapedVenue } from "./mainefairs";

const SOURCE_NAME = "joycescraftshows.com";
const BASE_URL = "https://www.joycescraftshows.com";

// Parse date range like "May 17-18, 2026" or "Jul 10-12, 2026"
function parseDateRange(dateText: string): { start: Date; end: Date } | null {
  const cleaned = dateText.trim().replace(/\s+/g, ' ');

  const monthMap: Record<string, number> = {
    'january': 0, 'jan': 0,
    'february': 1, 'feb': 1,
    'march': 2, 'mar': 2,
    'april': 3, 'apr': 3,
    'may': 4,
    'june': 5, 'jun': 5,
    'july': 6, 'jul': 6,
    'august': 7, 'aug': 7,
    'september': 8, 'sep': 8, 'sept': 8,
    'october': 9, 'oct': 9,
    'november': 10, 'nov': 10,
    'december': 11, 'dec': 11,
  };

  // "Month DD-DD, YYYY"
  const rangePattern = /(\w+)\s+(\d{1,2})\s*[–-]\s*(\d{1,2}),?\s*(\d{4})/i;
  const rangeMatch = cleaned.match(rangePattern);
  if (rangeMatch) {
    const month = monthMap[rangeMatch[1].toLowerCase()];
    if (month !== undefined) {
      const start = new Date(parseInt(rangeMatch[4]), month, parseInt(rangeMatch[2]), 10, 0, 0);
      const end = new Date(parseInt(rangeMatch[4]), month, parseInt(rangeMatch[3]), 16, 0, 0);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        return { start, end };
      }
    }
  }

  // Single date: "Month DD, YYYY"
  const singlePattern = /(\w+)\s+(\d{1,2}),?\s*(\d{4})/i;
  const singleMatch = cleaned.match(singlePattern);
  if (singleMatch) {
    const month = monthMap[singleMatch[1].toLowerCase()];
    if (month !== undefined) {
      const start = new Date(parseInt(singleMatch[3]), month, parseInt(singleMatch[2]), 10, 0, 0);
      const end = new Date(parseInt(singleMatch[3]), month, parseInt(singleMatch[2]), 17, 0, 0);
      if (!isNaN(start.getTime())) {
        return { start, end };
      }
    }
  }

  return null;
}

function createSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface JoycesEvent {
  name: string;
  dates: string;
  venue: string;
  address: string;
  city: string;
  state: string;
  description: string;
  sourceUrl: string;
}

const knownEvents: JoycesEvent[] = [
  {
    name: "Lakes Region Spring Craft Fair",
    dates: "May 17-18, 2026",
    venue: "Tanger Outlets",
    address: "120 Laconia Rd Rt 3",
    city: "Tilton",
    state: "NH",
    description: "Lakes Region Spring Craft Fair at Tanger Outlets, Tilton NH. 80+ artisans. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/lakes-region-spring-craft-fair`,
  },
  {
    name: "Memorial Day Weekend Craft Fair",
    dates: "May 23-24, 2026",
    venue: "Schouler Park",
    address: "1 Norcross Circle Rt 16",
    city: "North Conway",
    state: "NH",
    description: "Memorial Day Weekend Craft Fair at Schouler Park, North Conway NH. 125+ exhibitors. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/memorial-day-weekend-craft-fair`,
  },
  {
    name: "4th of July Weekend Gunstock Craft Fair",
    dates: "July 5-6, 2026",
    venue: "Gunstock Mountain Resort",
    address: "719 Cherry Valley Rd Rt 11A",
    city: "Gilford",
    state: "NH",
    description: "4th of July Weekend Gunstock Craft Fair at Gunstock Mountain Resort, Gilford NH. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/4th-of-july-weekend-gunstock-craft-fair`,
  },
  {
    name: "On The Green July Craft Fair",
    dates: "July 10-12, 2026",
    venue: "Brewster Academy",
    address: "80 Academy Dr",
    city: "Wolfeboro",
    state: "NH",
    description: "On The Green July Craft Fair at Brewster Academy, Wolfeboro NH. 100+ exhibitors. Friday-Sunday 10am-5pm (Sunday 10am-4pm). Free admission, free parking.",
    sourceUrl: `${BASE_URL}/on-the-green-july-craft-fair`,
  },
  {
    name: "Mt. Washington Valley July Craft Fair",
    dates: "July 27-28, 2026",
    venue: "Schouler Park",
    address: "1 Norcross Circle Rt 16",
    city: "North Conway",
    state: "NH",
    description: "Mt. Washington Valley July Craft Fair at Schouler Park, North Conway NH. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/mt-washington-valley-july-craft-fair`,
  },
  {
    name: "On The Green 2 August Craft Fair",
    dates: "August 8-10, 2026",
    venue: "Brewster Academy",
    address: "80 Academy Dr",
    city: "Wolfeboro",
    state: "NH",
    description: "On The Green 2 August Craft Fair at Brewster Academy, Wolfeboro NH. 110+ exhibitors. Friday-Sunday 10am-5pm (Sunday 10am-4pm). Free admission, free parking.",
    sourceUrl: `${BASE_URL}/on-the-green-2-august-craft-fair`,
  },
  {
    name: "Mt. Washington Valley August Craft Fair",
    dates: "August 16-17, 2026",
    venue: "Schouler Park",
    address: "1 Norcross Circle Rt 16",
    city: "North Conway",
    state: "NH",
    description: "Mt. Washington Valley August Craft Fair at Schouler Park, North Conway NH. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/mt-washington-valley-august-craft-fair`,
  },
  {
    name: "Gunstock Labor Day Craft Fair",
    dates: "August 30-31, 2026",
    venue: "Gunstock Mountain Resort",
    address: "719 Cherry Valley Rd Rt 11A",
    city: "Gilford",
    state: "NH",
    description: "Gunstock Labor Day Craft Fair at Gunstock Mountain Resort, Gilford NH. 100+ exhibitors. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/gunstock-labor-day-craft-fair`,
  },
  {
    name: "Falling Leaves Craft Fair at Tanger",
    dates: "September 20-21, 2026",
    venue: "Tanger Outlets",
    address: "120 Laconia Rd Rt 3",
    city: "Tilton",
    state: "NH",
    description: "Falling Leaves Craft Fair at Tanger Outlets, Tilton NH. 90+ artisans. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/falling-leaves-craft-fair-at-tanger`,
  },
  {
    name: "Mt. Washington Valley Fall Craft Fair",
    dates: "October 4-5, 2026",
    venue: "Schouler Park",
    address: "1 Norcross Circle Rt 16",
    city: "North Conway",
    state: "NH",
    description: "Mt. Washington Valley Fall Craft Fair at Schouler Park, North Conway NH. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/mt-washington-valley-fall-craft-fair`,
  },
  {
    name: "Columbus Day Weekend Gunstock Craft Fair",
    dates: "October 10-11, 2026",
    venue: "Gunstock Mountain Resort",
    address: "719 Cherry Valley Rd Rt 11A",
    city: "Gilford",
    state: "NH",
    description: "Columbus Day Weekend Gunstock Craft Fair at Gunstock Mountain Resort, Gilford NH. 70+ exhibitors. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/columbus-day-weekend-gunstock-craft-fair`,
  },
  {
    name: "Silver Bells Craft Fair at Tanger",
    dates: "November 1-2, 2026",
    venue: "Tanger Outlets",
    address: "120 Laconia Rd Rt 3",
    city: "Tilton",
    state: "NH",
    description: "Silver Bells Craft Fair at Tanger Outlets, Tilton NH. 90+ exhibitors. Saturday 10am-5pm, Sunday 10am-4pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/silver-bells-craft-fair-at-tanger`,
  },
  {
    name: "Holly Jolly Craft Fair at DoubleTree",
    dates: "December 14, 2026",
    venue: "DoubleTree by Hilton",
    address: "",
    city: "Nashua",
    state: "NH",
    description: "Holly Jolly Craft Fair at DoubleTree by Hilton, Nashua NH. Saturday 10am-5pm. Free admission, free parking.",
    sourceUrl: `${BASE_URL}/holly-jolly-craft-fair-at-doubletree`,
  },
];

export async function scrapeJoycesCraftShows(): Promise<ScrapeResult> {
  const events: ScrapedEvent[] = [];

  for (const eventInfo of knownEvents) {
    const dates = parseDateRange(eventInfo.dates);
    if (!dates) continue;

    const sourceId = createSlugFromName(eventInfo.name);
    if (events.some(e => e.sourceId === sourceId)) continue;

    const venue: ScrapedVenue = {
      name: eventInfo.venue,
      streetAddress: eventInfo.address,
      city: eventInfo.city,
      state: eventInfo.state,
    };

    events.push({
      sourceId,
      sourceName: SOURCE_NAME,
      sourceUrl: eventInfo.sourceUrl,
      name: eventInfo.name,
      startDate: dates.start,
      endDate: dates.end,
      datesConfirmed: true,
      venue,
      city: eventInfo.city,
      state: eventInfo.state,
      ticketUrl: eventInfo.sourceUrl,
      website: eventInfo.sourceUrl,
      description: eventInfo.description,
    });
  }

  return {
    success: true,
    events,
  };
}

// All event data is hardcoded inline, so detail scraping returns empty
export async function scrapeJoycesCraftShowsEventDetails(_eventUrl: string): Promise<Partial<ScrapedEvent>> {
  return {};
}
