import { describe, it, expect, vi } from "vitest";
import {
  extractDomain,
  gateUrlForField,
  shouldIngestFromSource,
  loadClassifications,
  gateUrlOnce,
  type ClassificationMap,
} from "../url-classification";

describe("extractDomain", () => {
  it("returns null for null/undefined/empty/non-string", () => {
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
    expect(extractDomain("")).toBeNull();
    expect(extractDomain("   ")).toBeNull();
    expect(extractDomain(123 as unknown as string)).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(extractDomain("not a url")).toBeNull();
    expect(extractDomain("http://")).toBeNull();
  });

  it("strips protocol and www, lowercases, drops path/query", () => {
    expect(extractDomain("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(extractDomain("HTTP://Example.COM")).toBe("example.com");
    expect(extractDomain("https://eventbrite.com/e/12345")).toBe("eventbrite.com");
  });

  it("accepts bare hostnames by prepending https://", () => {
    expect(extractDomain("example.com")).toBe("example.com");
    expect(extractDomain("www.example.com/path")).toBe("example.com");
  });

  it("handles subdomains (does not strip them)", () => {
    expect(extractDomain("https://shop.eventbrite.com/e/1")).toBe("shop.eventbrite.com");
  });
});

describe("gateUrlForField", () => {
  const classifications: ClassificationMap = new Map([
    [
      "fairsandfestivals.net",
      { useAsTicketUrl: false, useAsApplicationUrl: false, useAsSource: true },
    ],
    ["eventbrite.com", { useAsTicketUrl: true, useAsApplicationUrl: true, useAsSource: false }],
    [
      "joycescraftshows.com",
      { useAsTicketUrl: true, useAsApplicationUrl: true, useAsSource: true },
    ],
    ["zapplication.org", { useAsTicketUrl: false, useAsApplicationUrl: true, useAsSource: false }],
  ]);

  it("returns null for null/undefined/empty input", () => {
    expect(gateUrlForField(null, "ticket", classifications)).toBeNull();
    expect(gateUrlForField(undefined, "ticket", classifications)).toBeNull();
    expect(gateUrlForField("", "ticket", classifications)).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(gateUrlForField("not a url at all", "ticket", classifications)).toBeNull();
  });

  it("blocks aggregator domain in ticket context", () => {
    expect(
      gateUrlForField("https://fairsandfestivals.net/event/123", "ticket", classifications)
    ).toBeNull();
  });

  it("blocks aggregator domain in application context", () => {
    expect(
      gateUrlForField("https://www.fairsandfestivals.net/event/123", "application", classifications)
    ).toBeNull();
  });

  it("allows promoter domain in both contexts", () => {
    expect(
      gateUrlForField("https://joycescraftshows.com/show/abc", "ticket", classifications)
    ).toBe("https://joycescraftshows.com/show/abc");
    expect(
      gateUrlForField("https://joycescraftshows.com/apply", "application", classifications)
    ).toBe("https://joycescraftshows.com/apply");
  });

  it("allows context-specific destinations (ticketing platform)", () => {
    expect(gateUrlForField("https://www.eventbrite.com/e/1", "ticket", classifications)).toBe(
      "https://www.eventbrite.com/e/1"
    );
  });

  it("blocks application-only platform when used as ticket URL", () => {
    expect(gateUrlForField("https://zapplication.org/x", "ticket", classifications)).toBeNull();
    expect(gateUrlForField("https://zapplication.org/x", "application", classifications)).toBe(
      "https://zapplication.org/x"
    );
  });

  it("fails open for unknown domains in any context", () => {
    expect(gateUrlForField("https://unknown-promoter.org/", "ticket", classifications)).toBe(
      "https://unknown-promoter.org/"
    );
    expect(gateUrlForField("https://unknown-promoter.org/", "application", classifications)).toBe(
      "https://unknown-promoter.org/"
    );
  });
});

describe("shouldIngestFromSource", () => {
  const classifications: ClassificationMap = new Map([
    [
      "fairsandfestivals.net",
      { useAsTicketUrl: false, useAsApplicationUrl: false, useAsSource: true },
    ],
    ["festivalnet.com", { useAsTicketUrl: false, useAsApplicationUrl: false, useAsSource: false }],
  ]);

  it("returns true for null/undefined (nothing to gate)", () => {
    expect(shouldIngestFromSource(null, classifications)).toBe(true);
    expect(shouldIngestFromSource(undefined, classifications)).toBe(true);
  });

  it("returns true for unparseable URLs (fail-open)", () => {
    expect(shouldIngestFromSource("not a url", classifications)).toBe(true);
  });

  it("returns true for unknown domains (fail-open)", () => {
    expect(shouldIngestFromSource("https://unknown-aggregator.example/", classifications)).toBe(
      true
    );
  });

  it("returns true for source-allowed domains", () => {
    expect(shouldIngestFromSource("https://www.fairsandfestivals.net/", classifications)).toBe(
      true
    );
  });

  it("returns false only for explicitly-blocked sources", () => {
    expect(shouldIngestFromSource("https://festivalnet.com/event/1", classifications)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed paths
//
// loadClassifications/gateUrlOnce wrap the pure helpers above with a Drizzle
// query. We mock just the chain that's used: db.select(...).from(table).
// ---------------------------------------------------------------------------

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
}

function makeDb(
  rows: Array<{
    domain: string;
    useAsTicketUrl: boolean;
    useAsApplicationUrl: boolean;
    useAsSource: boolean;
  }>
): FakeDb {
  const db: FakeDb = {
    select: vi.fn(() => db),
    from: vi.fn(async () => rows),
  };
  return db;
}

describe("loadClassifications", () => {
  it("hydrates a Map keyed by domain", async () => {
    const db = makeDb([
      {
        domain: "eventbrite.com",
        useAsTicketUrl: true,
        useAsApplicationUrl: true,
        useAsSource: false,
      },
      {
        domain: "festivalnet.com",
        useAsTicketUrl: false,
        useAsApplicationUrl: false,
        useAsSource: false,
      },
    ]);

    // Cast away the Drizzle Db type — the test mock only implements the
    // narrow chain that's used (select(...).from(...)).
    const map = await loadClassifications(
      db as unknown as Parameters<typeof loadClassifications>[0]
    );

    expect(map.size).toBe(2);
    expect(map.get("eventbrite.com")).toEqual({
      useAsTicketUrl: true,
      useAsApplicationUrl: true,
      useAsSource: false,
    });
    expect(map.get("festivalnet.com")).toEqual({
      useAsTicketUrl: false,
      useAsApplicationUrl: false,
      useAsSource: false,
    });
  });

  it("returns an empty Map when no classification rows exist", async () => {
    const db = makeDb([]);
    const map = await loadClassifications(
      db as unknown as Parameters<typeof loadClassifications>[0]
    );
    expect(map.size).toBe(0);
  });
});

describe("gateUrlOnce", () => {
  it("returns null for empty input without hitting the DB", async () => {
    const db = makeDb([]);
    const result = await gateUrlOnce(
      db as unknown as Parameters<typeof gateUrlOnce>[0],
      null,
      "ticket"
    );
    expect(result).toBeNull();
    // Short-circuit on null URL — no SQL roundtrip incurred.
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns null for unparseable URLs without hitting the DB", async () => {
    const db = makeDb([]);
    const result = await gateUrlOnce(
      db as unknown as Parameters<typeof gateUrlOnce>[0],
      "not a url",
      "ticket"
    );
    expect(result).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("blocks a URL whose domain is classified with useAsTicketUrl=false", async () => {
    const db = makeDb([
      {
        domain: "fairsandfestivals.net",
        useAsTicketUrl: false,
        useAsApplicationUrl: false,
        useAsSource: true,
      },
    ]);
    const result = await gateUrlOnce(
      db as unknown as Parameters<typeof gateUrlOnce>[0],
      "https://www.fairsandfestivals.net/event/1",
      "ticket"
    );
    expect(result).toBeNull();
  });

  it("returns the URL unchanged for known-good ticketing platforms", async () => {
    const db = makeDb([
      {
        domain: "eventbrite.com",
        useAsTicketUrl: true,
        useAsApplicationUrl: true,
        useAsSource: false,
      },
    ]);
    const url = "https://www.eventbrite.com/e/12345";
    const result = await gateUrlOnce(
      db as unknown as Parameters<typeof gateUrlOnce>[0],
      url,
      "ticket"
    );
    expect(result).toBe(url);
  });

  it("returns the URL unchanged for unknown domains (fail-open)", async () => {
    const db = makeDb([]);
    const url = "https://unknown-promoter.example/show";
    const result = await gateUrlOnce(
      db as unknown as Parameters<typeof gateUrlOnce>[0],
      url,
      "application"
    );
    expect(result).toBe(url);
  });
});
