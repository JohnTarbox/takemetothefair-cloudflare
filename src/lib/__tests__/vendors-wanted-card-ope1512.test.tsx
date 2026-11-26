/**
 * OPE-1512 item 4 — the public "Vendors wanted" card renders only for a
 * positively OPEN, unexpired, whole-lane call, and omits lines with no data.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildVendorCall,
  formatBoothFee,
  type VendorCallEventFields,
  type VendorCallSource,
} from "@/lib/events/vendor-call";
import { VendorsWantedCard } from "@/components/events/VendorsWantedCard";

vi.mock("@/components/OutboundEventLink", () => ({
  OutboundEventLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const NOW = new Date("2026-10-25T16:00:00Z");
// The OPE-750 closing convention: 23:59:59 New York.
const CLOSES = new Date("2026-11-02T04:59:59Z");

const row = (over: Partial<VendorCallSource> = {}): VendorCallSource => ({
  department: null,
  url: "https://organizer.example/apply",
  closesAt: CLOSES,
  capacityStatus: "OPEN",
  capacityAsOf: null,
  categoriesWanted: JSON.stringify(["Pottery", "Woodworking", "Baked goods"]),
  categoriesFull: JSON.stringify(["Jewelry", "Candles"]),
  categoriesAsOf: new Date("2026-10-20T16:00:00Z"),
  ...over,
});

const event: VendorCallEventFields = {
  applicationUrl: null,
  vendorFeeMinCents: 7500,
  vendorFeeMaxCents: 12000,
  vendorFeeNotes: "10x10 · 10x20",
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("buildVendorCall", () => {
  it.each(["UNKNOWN", "WAITLIST", "FULL", "CLOSED", null])("shows nothing for %s", (status) => {
    expect(buildVendorCall(row({ capacityStatus: status }), event, NOW)).toBeNull();
  });

  it("shows nothing once the closing day has passed, and still does on the day", () => {
    const onTheDay = new Date("2026-11-01T20:00:00Z");
    const dayAfter = new Date("2026-11-02T14:00:00Z");
    expect(buildVendorCall(row(), event, onTheDay)).not.toBeNull();
    expect(buildVendorCall(row(), event, dayAfter)).toBeNull();
  });

  it("shows nothing for a single department's row, or for no row", () => {
    expect(buildVendorCall(row({ department: "Food court" }), event, NOW)).toBeNull();
    expect(buildVendorCall(null, event, NOW)).toBeNull();
  });

  it("refuses an unsafe link, and falls back to the event's own", () => {
    expect(buildVendorCall(row({ url: "javascript:alert(1)" }), event, NOW)?.applyHref).toBeNull();
    expect(
      buildVendorCall(row({ url: null }), { ...event, applicationUrl: "https://a.example/" }, NOW)
        ?.applyHref
    ).toBe("https://a.example/");
  });

  it("falls back to the capacity as-of date", () => {
    const view = buildVendorCall(
      row({ categoriesAsOf: null, capacityAsOf: new Date("2026-09-15T16:00:00Z") }),
      event,
      NOW
    );
    expect(view?.asOf).toBe("Sep 15, 2026");
  });
});

describe("formatBoothFee", () => {
  it("formats a range, a single price and cents", () => {
    expect(formatBoothFee(7500, 12000)).toBe("$75–$120");
    expect(formatBoothFee(7500, 7500)).toBe("$75");
    expect(formatBoothFee(null, 12000)).toBe("$120");
    expect(formatBoothFee(7550, null)).toBe("$75.50");
    expect(formatBoothFee(null, null)).toBeNull();
  });
});

describe("VendorsWantedCard", () => {
  const render = (over: Partial<VendorCallSource> = {}, ev = event) =>
    renderToStaticMarkup(
      <VendorsWantedCard call={buildVendorCall(row(over), ev, NOW)!} eventSlug="a-fair" />
    );

  it("reads as the approved card", () => {
    const t = text(render());
    expect(t).toContain("Vendors wanted");
    expect(t).toContain("Applications close Sun, Nov 1, 2026 · Booth fee $75–$120 (10x10 · 10x20)");
    expect(t).toContain("Looking for: Pottery, Woodworking, Baked goods");
    expect(t).toContain("Full: Jewelry, Candles");
    expect(t).toContain("Apply on the organizer's site →");
    expect(t).toContain("Vendor call as of Oct 20, 2026");
  });

  it("omits every line that has no data", () => {
    const html = render(
      {
        closesAt: null,
        url: null,
        categoriesWanted: null,
        categoriesFull: null,
        categoriesAsOf: null,
      },
      {
        applicationUrl: null,
        vendorFeeMinCents: null,
        vendorFeeMaxCents: null,
        vendorFeeNotes: null,
      }
    );
    const t = text(html);
    expect(t).toContain("Vendors wanted");
    for (const absent of [
      "Applications close",
      "Booth fee",
      "Looking for",
      "Full:",
      "Apply",
      "as of",
    ]) {
      expect(t).not.toContain(absent);
    }
    expect(html).not.toContain("<a ");
  });

  it("has no separator when only one of the two terms exists", () => {
    expect(text(render({ closesAt: null }))).not.toContain(" · Booth");
  });
});
