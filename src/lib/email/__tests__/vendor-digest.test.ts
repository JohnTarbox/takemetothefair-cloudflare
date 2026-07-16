/**
 * OPE-191 — vendor "New This Week" digest content. The apply-link chain, the
 * Dates-TBC flag, the empty→null rule, and the URL scheme guard are the parts
 * that would silently mis-send, so they're pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  renderVendorDigestContent,
  resolveApplyLink,
  formatShowDate,
  leadTimeLabel,
  type VendorDigestEvent,
} from "../vendor-digest";

const NOW = new Date("2026-07-16T12:00:00Z");

const ev = (over: Partial<VendorDigestEvent> = {}): VendorDigestEvent => ({
  name: "Fryeburg Fair",
  slug: "fryeburg-fair",
  startDate: new Date("2026-10-04T00:00:00Z"),
  isTentative: false,
  categories: ["Agricultural", "Craft"],
  commercialVendorsAllowed: true,
  estimatedAttendance: 150000,
  eventScale: "MAJOR",
  indoorOutdoor: "OUTDOOR",
  applicationUrl: null,
  sourceUrl: null,
  promoterWebsite: null,
  ...over,
});

describe("resolveApplyLink — chain application → source → promoter → event page", () => {
  it("prefers application_url", () => {
    expect(
      resolveApplyLink(ev({ applicationUrl: "https://apply.example", sourceUrl: "https://src" }))
    ).toBe("https://apply.example");
  });

  it("falls to source, then promoter, then the MMATF event page", () => {
    expect(resolveApplyLink(ev({ sourceUrl: "https://src.example" }))).toBe("https://src.example");
    expect(resolveApplyLink(ev({ promoterWebsite: "https://promoter.example" }))).toBe(
      "https://promoter.example"
    );
    expect(resolveApplyLink(ev())).toBe("https://meetmeatthefair.com/events/fryeburg-fair");
  });

  it("skips a non-http(s) stored URL rather than emitting it", () => {
    // Stored data can be junk; a javascript:/ftp: link must never reach an href.
    expect(resolveApplyLink(ev({ applicationUrl: "javascript:alert(1)" }))).toBe(
      "https://meetmeatthefair.com/events/fryeburg-fair"
    );
    expect(
      resolveApplyLink(ev({ applicationUrl: "not a url", sourceUrl: "https://ok.example" }))
    ).toBe("https://ok.example");
  });
});

describe("formatShowDate / leadTimeLabel", () => {
  it("shows the date, or 'Dates TBC' for a tentative or dateless show", () => {
    expect(formatShowDate(ev())).toBe("Oct 4, 2026");
    expect(formatShowDate(ev({ isTentative: true }))).toBe("Dates TBC");
    expect(formatShowDate(ev({ startDate: null }))).toBe("Dates TBC");
  });

  it("labels lead time in days / weeks / months", () => {
    expect(leadTimeLabel(new Date("2026-07-20T00:00:00Z"), NOW)).toMatch(/day/);
    expect(leadTimeLabel(new Date("2026-08-10T00:00:00Z"), NOW)).toMatch(/weeks/);
    expect(leadTimeLabel(new Date("2026-10-04T00:00:00Z"), NOW)).toMatch(/months/);
    expect(leadTimeLabel(null, NOW)).toBeNull();
    // A past date yields no chip (shouldn't happen post-guard, but be safe).
    expect(leadTimeLabel(new Date("2026-01-01T00:00:00Z"), NOW)).toBeNull();
  });
});

describe("renderVendorDigestContent", () => {
  it("returns null for an empty week — never mail an empty issue", () => {
    expect(renderVendorDigestContent([], NOW)).toBeNull();
  });

  it("renders a card with fit, crowd, apply link and event link", () => {
    const html = renderVendorDigestContent([ev()], NOW) ?? "";
    expect(html).toContain("Fryeburg Fair");
    expect(html).toContain("Agricultural, Craft");
    expect(html).toContain("commercial vendors welcome");
    expect(html).toContain("150,000 attendees");
    expect(html).toContain("Apply for a booth");
    expect(html).toContain("/events/fryeburg-fair");
  });

  it("shows Dates TBC in the glance table for tentative shows", () => {
    const html = renderVendorDigestContent([ev({ isTentative: true })], NOW) ?? "";
    expect(html).toContain("Dates TBC");
  });

  it("escapes the event name (stored free text)", () => {
    const html = renderVendorDigestContent([ev({ name: "A & B <Fair>" })], NOW) ?? "";
    expect(html).not.toContain("<Fair>");
    expect(html).toContain("A &amp; B &lt;Fair&gt;");
  });

  it("uses event scale when attendance is unknown", () => {
    const html =
      renderVendorDigestContent([ev({ estimatedAttendance: null, eventScale: "LARGE" })], NOW) ??
      "";
    expect(html).toContain("large show");
  });
});
