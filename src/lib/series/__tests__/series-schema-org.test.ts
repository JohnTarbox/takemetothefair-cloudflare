import { describe, it, expect } from "vitest";
import {
  seriesUrl,
  occurrenceUrl,
  buildEventSeriesJsonLd,
  buildSuperEventRef,
  derivedEventStatus,
  derivedImage,
  derivedOrganizer,
  derivedOffers,
  type SeriesForSchema,
  type OccurrenceForSchema,
} from "../series-schema-org";

const SITE = "https://meetmeatthefair.com";

const series: SeriesForSchema = {
  canonicalSlug: "newport-international-boat-show",
  name: "Newport International Boat Show",
};

const occ = (over: Partial<OccurrenceForSchema> & { slug: string }): OccurrenceForSchema => ({
  year: 2025,
  name: "Newport International Boat Show",
  ...over,
});

const venue = {
  name: "Newport Yachting Center",
  address: "4 Commercial Wharf",
  city: "Newport",
  state: "RI",
  zip: "02840",
  latitude: 41.486,
  longitude: -71.313,
};

describe("series/occurrence URLs", () => {
  it("seriesUrl is the year-agnostic landing path", () => {
    expect(seriesUrl("newport-international-boat-show")).toBe(
      `${SITE}/events/newport-international-boat-show`
    );
  });
  it("occurrenceUrl uses /<series>/<year> when the year is known", () => {
    expect(occurrenceUrl("newport-international-boat-show", 2025, "fallback-slug")).toBe(
      `${SITE}/events/newport-international-boat-show/2025`
    );
  });
  it("occurrenceUrl falls back to the event slug when the year is unknown", () => {
    expect(occurrenceUrl("newport-international-boat-show", null, "newport-2025-legacy")).toBe(
      `${SITE}/events/newport-2025-legacy`
    );
  });
});

describe("buildEventSeriesJsonLd", () => {
  it("emits a top-level EventSeries with @context and url", () => {
    const ld = buildEventSeriesJsonLd(series, []);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("EventSeries");
    expect(ld.name).toBe("Newport International Boat Show");
    expect(ld.url).toBe(`${SITE}/events/newport-international-boat-show`);
  });

  it("omits subEvent entirely when there are no occurrences", () => {
    expect(buildEventSeriesJsonLd(series, [])).not.toHaveProperty("subEvent");
  });

  it("builds subEvent nodes with Option-A occurrence URLs + dates", () => {
    const ld = buildEventSeriesJsonLd(series, [
      occ({
        slug: "newport-2025",
        year: 2025,
        startDateIso: "2025-09-11",
        endDateIso: "2025-09-14",
      }),
      occ({ slug: "newport-2026", year: 2026 }),
    ]);
    const sub = ld.subEvent as Array<Record<string, unknown>>;
    expect(sub).toHaveLength(2);
    expect(sub[0]).toMatchObject({
      "@type": "Event",
      url: `${SITE}/events/newport-international-boat-show/2025`,
      startDate: "2025-09-11",
      endDate: "2025-09-14",
    });
    // second occurrence has no dates → those keys are absent
    expect(sub[1]).not.toHaveProperty("startDate");
    expect(sub[1].url).toBe(`${SITE}/events/newport-international-boat-show/2026`);
  });

  it("includes description and image only when present", () => {
    const bare = buildEventSeriesJsonLd(series, []);
    expect(bare).not.toHaveProperty("description");
    expect(bare).not.toHaveProperty("image");

    const rich = buildEventSeriesJsonLd(
      { ...series, description: "Annual boat show", imageUrl: "https://img/x.jpg" },
      []
    );
    expect(rich.description).toBe("Annual boat show");
    expect(rich.image).toBe("https://img/x.jpg");
  });
});

// K46 (2026-06-26) — the 360-error GSC defect: EventSeries + every subEvent
// must carry a `location`, and the EventSeries must carry top-level dates.
describe("K46 — location + dates", () => {
  it("always emits a top-level location (falls back to 'Location to be announced')", () => {
    const ld = buildEventSeriesJsonLd(series, []);
    expect(ld.location).toMatchObject({ "@type": "Place", name: "Location to be announced" });
  });

  it("emits the series-level location from the (hero) venue + top-level dates", () => {
    const ld = buildEventSeriesJsonLd(
      { ...series, venue, startDateIso: "2026-09-17", endDateIso: "2026-09-20" },
      []
    );
    expect(ld.startDate).toBe("2026-09-17");
    expect(ld.endDate).toBe("2026-09-20");
    expect(ld.location).toMatchObject({
      "@type": "Place",
      name: "Newport Yachting Center",
      address: {
        "@type": "PostalAddress",
        streetAddress: "4 Commercial Wharf",
        addressLocality: "Newport",
        addressRegion: "RI",
        postalCode: "02840",
        addressCountry: "US",
      },
      geo: { "@type": "GeoCoordinates", latitude: 41.486, longitude: -71.313 },
    });
  });

  it("omits top-level startDate/endDate when the series has none", () => {
    const ld = buildEventSeriesJsonLd(series, []);
    expect(ld).not.toHaveProperty("startDate");
    expect(ld).not.toHaveProperty("endDate");
  });

  it("emits a location on every subEvent (from the occurrence's own venue)", () => {
    const ld = buildEventSeriesJsonLd(series, [
      occ({ slug: "newport-2025", year: 2025, venue }),
      occ({ slug: "newport-2026", year: 2026 }), // no venue
    ]);
    const sub = ld.subEvent as Array<Record<string, unknown>>;
    expect(sub[0].location).toMatchObject({
      "@type": "Place",
      name: "Newport Yachting Center",
      address: { addressLocality: "Newport", addressRegion: "RI" },
    });
    // venueless occurrence still carries a Place so Google doesn't flag it.
    expect(sub[1].location).toMatchObject({ "@type": "Place", name: "Location to be announced" });
  });

  it("uses displayVenueName so a street-address-named venue isn't shown raw", () => {
    const streetVenue = {
      name: "18 Spring Street",
      address: "18 Spring Street",
      city: "Newport",
      state: "RI",
    };
    const ld = buildEventSeriesJsonLd({ ...series, venue: streetVenue }, []);
    expect((ld.location as Record<string, unknown>).name).toBe("Event venue in Newport, RI");
  });

  it("drops undefined keys (geo, streetAddress) on JSON.stringify round-trip", () => {
    // The real emission path is JSON.stringify(jsonLd); assert it omits the
    // optional keys rather than serialising nulls.
    const minimalVenue = { name: "Town Common", city: "Bondville", state: "VT" };
    const ld = buildEventSeriesJsonLd({ ...series, venue: minimalVenue }, []);
    const round = JSON.parse(JSON.stringify(ld));
    expect(round.location).not.toHaveProperty("geo");
    expect(round.location.address).not.toHaveProperty("streetAddress");
    expect(round.location.address).not.toHaveProperty("postalCode");
    expect(round.location.address.addressLocality).toBe("Bondville");
  });
});

// OPE-18 (2026-06-29) — parent-derivation parity for the WARNING-set Google
// Event fields on the EventSeries builder + every subEvent.
describe("OPE-18 — derivation helpers", () => {
  it("derivedEventStatus maps lifecycle_status; omits past/unknown states", () => {
    expect(derivedEventStatus("SCHEDULED")).toBe("https://schema.org/EventScheduled");
    expect(derivedEventStatus("CANCELLED")).toBe("https://schema.org/EventCancelled");
    expect(derivedEventStatus("MOVED_ONLINE")).toBe("https://schema.org/EventMovedOnline");
    expect(derivedEventStatus("OCCURRED")).toBeUndefined(); // maps to null → omitted
    expect(derivedEventStatus(null)).toBeUndefined();
    expect(derivedEventStatus(undefined)).toBeUndefined();
  });

  it("derivedImage returns the first non-empty candidate (the fallback chain)", () => {
    expect(derivedImage(null, "", "  ", "https://img/c.jpg")).toBe("https://img/c.jpg");
    expect(derivedImage("https://img/a.jpg", "https://img/b.jpg")).toBe("https://img/a.jpg");
    expect(derivedImage(null, undefined, "")).toBeUndefined();
  });

  it("derivedOrganizer emits an Organization with optional url/logo", () => {
    expect(
      derivedOrganizer({ name: "Acme Fairs", url: "https://acme", logoUrl: "https://l.png" })
    ).toEqual({
      "@type": "Organization",
      name: "Acme Fairs",
      url: "https://acme",
      logo: "https://l.png",
    });
    expect(derivedOrganizer({ name: "Bare Org" })).toEqual({
      "@type": "Organization",
      name: "Bare Org",
    });
    expect(derivedOrganizer(null)).toBeUndefined();
    expect(derivedOrganizer({ name: "" })).toBeUndefined();
  });

  it("derivedOffers builds Offer vs AggregateOffer from integer cents", () => {
    expect(
      derivedOffers({ priceMinCents: 1000, priceMaxCents: 1500, ticketUrl: "https://t" })
    ).toMatchObject({
      "@type": "AggregateOffer",
      lowPrice: 10,
      highPrice: 15,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: "https://t",
    });
    expect(derivedOffers({ priceMinCents: 2000, priceMaxCents: 2000 })).toMatchObject({
      "@type": "Offer",
      price: 20,
      availability: "https://schema.org/InStock",
    });
    expect(derivedOffers({ priceMinCents: 0 })).toMatchObject({ "@type": "Offer", price: 0 });
    expect(derivedOffers({ ticketUrl: "https://t" })).toBeUndefined(); // no price → no offers
  });
});

describe("OPE-18 — WARNING-set parity on subEvents + series", () => {
  const richOcc = occ({
    slug: "newport-2025",
    year: 2025,
    venue,
    lifecycleStatus: "SCHEDULED",
    imageUrl: "https://img/occ.jpg",
    description: "The 2025 edition.",
    ticketUrl: "https://tix",
    ticketPriceMinCents: 2500,
    ticketPriceMaxCents: 4000,
  });

  it("emits eventStatus/image/description/organizer/offers on each subEvent when known", () => {
    const ld = buildEventSeriesJsonLd(
      { ...series, organizer: { name: "Newport Shows", url: "https://ns" } },
      [richOcc]
    );
    const sub = (ld.subEvent as Array<Record<string, unknown>>)[0];
    expect(sub.eventStatus).toBe("https://schema.org/EventScheduled");
    expect(sub.image).toBe("https://img/occ.jpg");
    expect(sub.description).toBe("The 2025 edition.");
    expect(sub.organizer).toMatchObject({ "@type": "Organization", name: "Newport Shows" });
    expect(sub.offers).toMatchObject({ "@type": "AggregateOffer", lowPrice: 25, highPrice: 40 });
  });

  it("image fallback chain: occurrence image → venue hero → promoter logo → series image", () => {
    const ld = buildEventSeriesJsonLd(
      {
        ...series,
        venueImageUrl: "https://venue.jpg",
        promoterLogoUrl: "https://logo.png",
        imageUrl: "https://series.jpg",
      },
      [occ({ slug: "x", year: 2025 })] // occurrence has no image
    );
    const sub = (ld.subEvent as Array<Record<string, unknown>>)[0];
    expect(sub.image).toBe("https://venue.jpg"); // falls through to venue hero
  });

  it("omits WARNING-set keys on a subEvent with no source data (no empty emits)", () => {
    const ld = buildEventSeriesJsonLd(series, [occ({ slug: "bare", year: 2025 })]);
    const sub = (ld.subEvent as Array<Record<string, unknown>>)[0];
    expect(sub).not.toHaveProperty("eventStatus");
    expect(sub).not.toHaveProperty("image");
    expect(sub).not.toHaveProperty("organizer");
    expect(sub).not.toHaveProperty("offers");
  });

  it("emits series-level eventStatus + organizer; top-level image still wins", () => {
    const ld = buildEventSeriesJsonLd(
      {
        ...series,
        lifecycleStatus: "POSTPONED",
        organizer: { name: "Org" },
        imageUrl: "https://real.jpg",
        promoterLogoUrl: "https://logo.png",
      },
      []
    );
    expect(ld.eventStatus).toBe("https://schema.org/EventPostponed");
    expect(ld.organizer).toMatchObject({ "@type": "Organization", name: "Org" });
    expect(ld.image).toBe("https://real.jpg"); // real series image not overwritten
  });
});

describe("buildSuperEventRef", () => {
  it("emits a nested EventSeries reference without @context", () => {
    const ref = buildSuperEventRef(series);
    expect(ref).toEqual({
      "@type": "EventSeries",
      name: "Newport International Boat Show",
      url: `${SITE}/events/newport-international-boat-show`,
    });
    expect(ref).not.toHaveProperty("@context");
  });
});
