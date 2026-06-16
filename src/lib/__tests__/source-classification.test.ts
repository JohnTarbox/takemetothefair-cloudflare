import { describe, it, expect } from "vitest";
import { classifySource } from "../source-classification";

describe("classifySource — analyst backlog Item 1 (2026-05-26)", () => {
  // ---- domain extraction ----

  it("extracts hostname from a source URL (preferred)", () => {
    const r = classifySource(null, "https://joycescraftshows.com/events/spring-2026");
    expect(r.sourceDomain).toBe("joycescraftshows.com");
  });

  it("strips www. when the URL hostname carries it", () => {
    const r = classifySource(null, "https://www.capecodchamber.org/events/x");
    expect(r.sourceDomain).toBe("capecodchamber.org");
  });

  it("returns null for non-http schemes", () => {
    const r = classifySource(null, "mailto:foo@bar.com");
    expect(r.sourceDomain).toBe(null);
  });

  it("falls back to sourceName when URL is missing but name looks like a host", () => {
    const r = classifySource("bangorfarmersmarket.org", null);
    expect(r.sourceDomain).toBe("bangorfarmersmarket.org");
  });

  it("strips parenthetical annotations from a name", () => {
    const r = classifySource("visitaroostook.com (verified 2026-05-18)", null);
    expect(r.sourceDomain).toBe("visitaroostook.com");
  });

  it("returns null when the name has no dot", () => {
    const r = classifySource("vendor-submission", null);
    expect(r.sourceDomain).toBe(null);
  });

  // ---- ingestion method ----

  it("maps email-submission label to email_submission method", () => {
    const r = classifySource("email-submission", null);
    expect(r.ingestionMethod).toBe("email_submission");
  });

  it("maps vendor-submission label to vendor_submission method", () => {
    const r = classifySource("vendor-submission", null);
    expect(r.ingestionMethod).toBe("vendor_submission");
  });

  // K26 (2026-06-16): daily-discovery harvest labels → 'discovery', so
  // discovery events created via suggest_event aren't mis-bucketed as
  // vendor_submission.
  it("maps daily-discovery label to discovery method", () => {
    expect(classifySource("daily-discovery", null).ingestionMethod).toBe("discovery");
    expect(classifySource("discovery", null).ingestionMethod).toBe("discovery");
    expect(
      classifySource("daily-ne-event-discovery", "https://towncalendar.example/events")
        .ingestionMethod
    ).toBe("discovery");
  });

  it("maps community-suggestion label to community_suggestion method", () => {
    const r = classifySource("community-suggestion", null);
    expect(r.ingestionMethod).toBe("community_suggestion");
  });

  it("maps url-import label to admin_manual method", () => {
    const r = classifySource("url-import", null);
    expect(r.ingestionMethod).toBe("admin_manual");
  });

  it("treats a bare aggregator domain as aggregator_import", () => {
    // capecodchamber.org is in the Tier-3 aggregator list per
    // event-date-gates.ts.
    const r = classifySource(null, "https://www.capecodchamber.org/events/x");
    expect(r.ingestionMethod).toBe("aggregator_import");
    expect(r.sourceDomain).toBe("capecodchamber.org");
  });

  it("treats a bare publisher domain as direct_scrape", () => {
    const r = classifySource("joycescraftshows.com", "https://joycescraftshows.com/x");
    expect(r.ingestionMethod).toBe("direct_scrape");
    expect(r.sourceDomain).toBe("joycescraftshows.com");
  });

  it("defaults to admin_manual for empty inputs (never returns null method)", () => {
    // Empty source info → most commonly an admin-created or pre-source-
    // tracking row. Defaulting to admin_manual instead of null keeps the
    // backfill WHERE clause from re-selecting the row forever.
    expect(classifySource(null, null)).toEqual({
      sourceDomain: null,
      ingestionMethod: "admin_manual",
    });
    expect(classifySource("", "")).toEqual({
      sourceDomain: null,
      ingestionMethod: "admin_manual",
    });
  });

  it("handles the freeform-name case (e.g. chamber names)", () => {
    // "St. John Valley Chamber of Commerce" — has no dot-as-tld, doesn't
    // look like a hostname. Should classify as admin_manual with no domain.
    const r = classifySource("St. John Valley Chamber of Commerce", null);
    expect(r.sourceDomain).toBe(null);
    expect(r.ingestionMethod).toBe("admin_manual");
  });

  it("URL wins when both URL and name are present and disagree", () => {
    const r = classifySource("joycescraftshows.com", "https://capecodchamber.org/event/x");
    expect(r.sourceDomain).toBe("capecodchamber.org");
    // Method falls through to aggregator_import via the domain (capecod is tier-3)
    expect(r.ingestionMethod).toBe("aggregator_import");
  });
});
