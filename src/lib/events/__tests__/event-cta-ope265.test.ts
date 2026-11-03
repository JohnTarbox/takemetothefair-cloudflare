import { describe, expect, it } from "vitest";
import { isFairgoerSourceUrl, pickEventCta } from "../event-cta";

describe("OPE-265 isFairgoerSourceUrl", () => {
  it("accepts an organizer page (real rows from 2026-10-01)", () => {
    expect(
      isFairgoerSourceUrl("https://www.threesaintsinc.org/99th-feast-of-the-three-saints")
    ).toBe(true);
    expect(isFairgoerSourceUrl("https://www.brimfieldantiqueweek.com/")).toBe(true);
    expect(isFairgoerSourceUrl("https://sites.google.com/view/some-fair/home")).toBe(true);
  });

  it("rejects a vendor-application page — Shaker Hill's real source_url", () => {
    expect(
      isFairgoerSourceUrl(
        "https://alfredshakermuseum.org/2026-shaker-hill-apple-festival-vendor-application/"
      )
    ).toBe(false);
    expect(isFairgoerSourceUrl("https://example.org/exhibitors")).toBe(false);
    expect(isFairgoerSourceUrl("https://example.org/apply-now")).toBe(false);
  });

  it("rejects our own domain, redirectors and forms", () => {
    expect(isFairgoerSourceUrl("https://meetmeatthefair.com/events/x")).toBe(false);
    expect(isFairgoerSourceUrl("https://www.meetmeatthefair.com/events/x")).toBe(false);
    expect(isFairgoerSourceUrl("https://share.google/abc123")).toBe(false);
    expect(isFairgoerSourceUrl("https://bit.ly/abc")).toBe(false);
    expect(isFairgoerSourceUrl("https://www.google.com/url?q=https://x.org")).toBe(false);
    expect(isFairgoerSourceUrl("https://forms.gle/TDVYvY1HPxtkRwsM9")).toBe(false);
    expect(isFairgoerSourceUrl("https://us5.list-manage.com/track/click?u=1")).toBe(false);
  });

  it("rejects anything that is not an absolute http(s) URL", () => {
    expect(isFairgoerSourceUrl(null)).toBe(false);
    expect(isFairgoerSourceUrl("")).toBe(false);
    expect(isFairgoerSourceUrl("email:submit@meetmeatthefair.com")).toBe(false);
    expect(isFairgoerSourceUrl("javascript:alert(1)")).toBe(false);
    expect(isFairgoerSourceUrl("example.org")).toBe(false);
  });
});

describe("OPE-265 pickEventCta", () => {
  it("a ticket URL wins and keeps the existing label — converting pages are unchanged", () => {
    expect(
      pickEventCta({
        ticketUrl: "https://www.fryeburgfair.org/p/about1/tickets",
        vettedSourceUrl: "https://www.fryeburgfair.org/",
        ticketPriceMaxCents: 1500,
      })
    ).toEqual({
      url: "https://www.fryeburgfair.org/p/about1/tickets",
      ctaSource: "ticket_url",
      label: "Event Website",
    });
  });

  it("falls back to the vetted source URL, labelled by whether admission is charged", () => {
    expect(
      pickEventCta({
        ticketUrl: null,
        vettedSourceUrl: "https://www.goshenfair.org/",
        ticketPriceMaxCents: 1000,
      })
    ).toEqual({
      url: "https://www.goshenfair.org/",
      ctaSource: "source_url",
      label: "Tickets & Info",
    });
    // Free (0) and unknown (null) price never say "Tickets".
    for (const price of [0, null]) {
      expect(
        pickEventCta({
          ticketUrl: "  ",
          vettedSourceUrl: "https://www.southingtonct.gov/AHF/",
          ticketPriceMaxCents: price,
        })?.label
      ).toBe("Official Event Website");
    }
  });

  it("renders nothing when neither URL is usable", () => {
    expect(pickEventCta({ ticketUrl: null, vettedSourceUrl: null, ticketPriceMaxCents: 500 })).toBe(
      null
    );
  });
});
