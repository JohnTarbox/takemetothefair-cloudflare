/**
 * OPE-1270 — vendors.website is health-checked, a cross-domain redirect is its
 * own verdict, and name drift is detected without the false mismatches the
 * ticket's own sample confirmed as same-entity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { healthIssues } from "../db/schema";
import {
  declaredOrganizationNames,
  detectNameDrift,
  sameBusinessName,
} from "../goodwill/name-drift";
import { classifyVendorSite } from "../goodwill/vendor-site-health";
import { normalizeHealthMessageKey } from "../site-health-group-key";
import { projectUrlHealthFlag, projectUrlHealthVerdict } from "../url-health-issues";

const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
/** A real-looking page: enough visible text to clear MIN_MEANINGFUL_TEXT. */
const page = (head: string, body = "We make things by hand. ".repeat(20)) =>
  `<html><head><title>Shop</title>${head}</head><body><p>${body}</p></body></html>`;

describe("name drift — the three specimens fire", () => {
  it("Bay State Savings Bank vs the site's 'Bay State Bank'", () => {
    const html = page(
      ld({ "@type": "BankOrCreditUnion", name: "Bay State Bank", telephone: "+1-508-000-0000" })
    );
    expect(detectNameDrift("Bay State Savings Bank", html)).toEqual({
      drift: true,
      declared: ["Bay State Bank"],
    });
  });

  it("Promethea Potters vs a LocalBusiness 'Promethea Arts' inside @graph", () => {
    const html = page(
      ld({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", name: "Promethea" },
          { "@type": "LocalBusiness", name: "Promethea Arts", address: "68 Main St" },
        ],
      })
    );
    expect(detectNameDrift("Promethea Potters", html).drift).toBe(true);
  });

  it("Premier Generator vs legalName 'Premier Energy Solutions Inc.'", () => {
    const html = page(
      ld({ "@type": ["Organization", "Electrician"], legalName: "Premier Energy Solutions Inc." })
    );
    expect(detectNameDrift("Premier Generator", html).drift).toBe(true);
  });
});

describe("name drift — the same-entity pairs from the sample must NOT fire", () => {
  const pairs: [string, string][] = [
    ["W.E. Brown Roofing", "WE Brown Roofing"],
    ["H.G. Johnson", "HG Johnson"],
    ["Ye Olde Pepper Candy Companie, LTD", "Ye Olde Pepper Candy Companie"],
    ["Laiken Mae Handmade", "Laiken Mae Hand Made"],
  ];
  for (const [ours, theirs] of pairs) {
    it(`${ours} ↔ ${theirs}`, () => {
      expect(sameBusinessName(ours, theirs)).toBe(true);
      expect(sameBusinessName(theirs, ours)).toBe(true);
      const html = page(ld({ "@type": "Organization", name: theirs }));
      expect(detectNameDrift(ours, html).drift).toBe(false);
    });
  }

  it("& and 'and', HTML entities, and a longer trading name are the same business", () => {
    expect(sameBusinessName("Smith & Sons Pottery", "Smith and Sons Pottery")).toBe(true);
    expect(sameBusinessName("Smith &amp; Sons Pottery LLC", "Smith and Sons Pottery")).toBe(true);
    expect(sameBusinessName("Joe's Pottery", "Joes Pottery Studio of Maine")).toBe(true);
  });

  it("but a short shared word is not containment ('Co' is inside everything)", () => {
    expect(sameBusinessName("Acme Co", "Bay State Bank")).toBe(false);
  });
});

describe("name drift — unknown is not 'no drift'", () => {
  it("no JSON-LD → null, not false", () => {
    expect(detectNameDrift("Anything", page("")).drift).toBeNull();
  });
  it("a subtype the regex cannot know, with no business properties, is not trusted", () => {
    const html = page(ld({ "@type": "BankOrCreditUnion", name: "Bay State Bank" }));
    expect(detectNameDrift("Bay State Savings Bank", html).drift).toBeNull();
  });
  it("only non-organization nodes (an Event, a WebSite) → null", () => {
    const html = page(
      ld([
        { "@type": "Event", name: "Fall Fair" },
        { "@type": "WebSite", name: "Totally Different" },
      ])
    );
    expect(declaredOrganizationNames(html)).toEqual([]);
    expect(detectNameDrift("Bay State Savings Bank", html).drift).toBeNull();
  });
  it("a broken JSON-LD block is skipped, not thrown", () => {
    const html = page('<script type="application/ld+json">{not json</script>');
    expect(detectNameDrift("X", html).drift).toBeNull();
  });
});

describe("vendor verdicts — healthy means substantive, not 'has fair dates'", () => {
  const site = "https://www.example-crafts.com/";

  it("a real vendor page with no event vocabulary is ok (the organizer classifier calls it no_event_signal)", () => {
    const r = classifyVendorSite(
      { reachedOrigin: true, status: 200, html: page(""), finalUrl: site },
      { requestedUrl: site, businessName: "Example Crafts" }
    );
    expect(r.verdict).toBe("ok");
  });

  it("ACCEPTANCE: baystatesavingsbank.com → baystatebank.com is `moved`, distinct from ok and from dead", () => {
    const r = classifyVendorSite(
      {
        reachedOrigin: true,
        status: 200,
        html: page(
          ld({ "@type": "BankOrCreditUnion", name: "Bay State Bank", telephone: "+1-508-000-0000" })
        ),
        finalUrl: "https://www.baystatebank.com/",
      },
      { requestedUrl: "https://baystatesavingsbank.com/", businessName: "Bay State Savings Bank" }
    );
    expect(r.verdict).toBe("moved");
    expect(r.signals).toContain("cross-domain-redirect:baystatebank.com");
    expect(r.nameDrift.drift).toBe(true);
    expect(r.signals.some((s) => s.startsWith("name-drift:Bay State Bank"))).toBe(true);
  });

  it("a same-domain redirect (http → https www) is NOT moved", () => {
    const r = classifyVendorSite(
      {
        reachedOrigin: true,
        status: 200,
        html: page(""),
        finalUrl: "https://www.example-crafts.com/",
      },
      { requestedUrl: "http://example-crafts.com", businessName: "Example Crafts" }
    );
    expect(r.verdict).toBe("ok");
  });

  it("a 200 with almost no text is empty_page (recorded as evidence, not queued)", () => {
    const r = classifyVendorSite(
      { reachedOrigin: true, status: 200, html: "<html><body></body></html>", finalUrl: site },
      { requestedUrl: site, businessName: "Example Crafts" }
    );
    expect(r.verdict).toBe("empty_page");
  });

  it("dead stays dead: unreachable and http_error come straight from the base classifier", () => {
    expect(
      classifyVendorSite(
        { reachedOrigin: false, status: null, html: null },
        { requestedUrl: site, businessName: "X" }
      ).verdict
    ).toBe("unreachable");
    expect(
      classifyVendorSite(
        { reachedOrigin: true, status: 404, html: "nope", finalUrl: site },
        { requestedUrl: site, businessName: "X" }
      ).verdict
    ).toBe("http_error");
  });
});

// ── the queue half ──────────────────────────────────────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
    issue_type TEXT NOT NULL, severity TEXT NOT NULL, url TEXT, message TEXT,
    first_detected_at INTEGER NOT NULL, last_detected_at INTEGER NOT NULL,
    resolved_at INTEGER, resolution_reason TEXT, last_reverified_at INTEGER
  );
`;
function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  return drizzle(sqlite, { schema });
}
const asDb = (db: ReturnType<typeof makeDb>) =>
  db as unknown as Parameters<typeof projectUrlHealthVerdict>[0];
const V = "vendors.website";
const U = "https://baystatesavingsbank.com/";
const D1 = new Date("2026-10-02T06:00:00Z");
const D2 = new Date("2026-10-03T06:00:00Z");

describe("vendor rows reach the queue through OPE-1280's projector", () => {
  it("moved projects a WARNING row for vendors.website", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), {
      sourceField: V,
      url: U,
      verdict: "moved",
      httpStatus: 200,
      checkedAt: D1,
    });
    const [row] = db.select().from(healthIssues).all();
    expect(row.issueType).toBe("URL_HEALTH_MOVED");
    expect(row.severity).toBe("WARNING");
    expect(row.message).toBe(
      "vendors.website redirects to a different domain · HTTP 200 · last checked 2026-10-02"
    );
  });

  it("empty_page is recorded but NOT queued — from a Worker it is usually a bot wall (OPE-1281)", async () => {
    const db = makeDb();
    const r = await projectUrlHealthVerdict(asDb(db), {
      sourceField: V,
      url: U,
      verdict: "empty_page",
      httpStatus: 200,
      checkedAt: D1,
    });
    expect(r).toEqual({ opened: 0, reopened: 0, refreshed: 0, resolved: 0 });
    expect(db.select().from(healthIssues).all()).toHaveLength(0);
  });

  it("name drift is a separate INFO row that an ok verdict does NOT close", async () => {
    const db = makeDb();
    await projectUrlHealthFlag(asDb(db), {
      sourceField: V,
      url: U,
      flag: "name_drift",
      present: true,
      checkedAt: D1,
    });
    await projectUrlHealthVerdict(asDb(db), {
      sourceField: V,
      url: U,
      verdict: "ok",
      httpStatus: 200,
      checkedAt: D2,
    });
    const [row] = db.select().from(healthIssues).all();
    expect(row.issueType).toBe("URL_HEALTH_NAME_DRIFT");
    expect(row.severity).toBe("INFO");
    expect(row.resolvedAt).toBeNull();
  });

  it("a re-check that READS a matching name closes it; one that reads no name leaves it open", async () => {
    const db = makeDb();
    await projectUrlHealthFlag(asDb(db), {
      sourceField: V,
      url: U,
      flag: "name_drift",
      present: true,
      checkedAt: D1,
    });
    const unknown = await projectUrlHealthFlag(asDb(db), {
      sourceField: V,
      url: U,
      flag: "name_drift",
      present: null,
      checkedAt: D2,
    });
    expect(unknown).toEqual({ opened: 0, reopened: 0, refreshed: 0, resolved: 0 });
    expect(db.select().from(healthIssues).all()[0].resolvedAt).toBeNull();

    const fixed = await projectUrlHealthFlag(asDb(db), {
      sourceField: V,
      url: U,
      flag: "name_drift",
      present: false,
      checkedAt: D2,
    });
    expect(fixed.resolved).toBe(1);
    expect(db.select().from(healthIssues).all()[0].resolutionReason).toBe("verified_fixed");
  });
});

describe("the sweep is wired and never writes the vendor (source-level)", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/admin/url-health/vendors/sweep/route.ts"),
    "utf8"
  );
  const WORKFLOW = readFileSync(
    join(process.cwd(), "mcp-server/src/workflows/event-date-drift.ts"),
    "utf8"
  );

  it("the route records vendors.website and projects verdict + name-drift flag", () => {
    expect(ROUTE).toContain('const SOURCE_FIELD = "vendors.website";');
    expect(ROUTE).toContain("await db.insert(urlHealthChecks).values(");
    expect(ROUTE).toContain("await projectUrlHealthVerdict(db, {");
    expect(ROUTE).toMatch(/await projectUrlHealthFlag\(db, \{[\s\S]{0,120}flag: "name_drift"/);
  });

  it("the route never updates or inserts into vendors (no rename, no website rewrite)", () => {
    expect(ROUTE).not.toMatch(/\.update\(\s*vendors\b/);
    expect(ROUTE).not.toMatch(/UPDATE\s+vendors/i);
    expect(ROUTE).not.toMatch(/\.insert\(\s*vendors\b/);
  });

  it("the daily workflow drives it", () => {
    expect(WORKFLOW).toContain("/api/admin/url-health/vendors/sweep?chunk=50");
    expect(WORKFLOW).toMatch(/for \(let i = 0; i < VENDOR_URL_HEALTH_CHUNKS_PER_RUN; i\+\+\)/);
  });
});

// ── OPE-1270 rework (2026-10-04) — the three items the review returned ─────

describe("rework 1 — Laiken Mae: the site's TRADING name is its WebSite title", () => {
  // The live shape of laikenmaehandmade.squarespace.com, read 2026-10-04:
  // Squarespace's business-info panel holds the owner's personal name.
  const LAIKEN =
    page(
      ld({
        "@type": "WebSite",
        name: "Laiken Mae Handmade",
        url: "https://laikenmaehandmade.squarespace.com",
      })
    ) +
    ld({ "@type": "Organization", legalName: "Laiken Flynn", telephone: "5182670524" }) +
    ld({ "@type": "LocalBusiness", name: "Laiken Flynn", address: "364 Leedale Street" });

  it("ACCEPTANCE NEGATIVE: 'Laiken Mae Hand Made' raises NOTHING", () => {
    expect(detectNameDrift("Laiken Mae Hand Made", LAIKEN).drift).toBe(false);
  });

  it("a WebSite title alone never RAISES drift — no org declaration stays unknown", () => {
    const html = page(ld({ "@type": "WebSite", name: "Home" }));
    expect(detectNameDrift("Bay State Savings Bank", html).drift).toBeNull();
  });

  it("a WebSite title clears only on an EXACT match — a different title does not clear real drift", () => {
    const html =
      page(ld({ "@type": "WebSite", name: "Welcome to our shop" })) +
      ld({ "@type": "Organization", name: "Bay State Bank" });
    expect(detectNameDrift("Bay State Savings Bank", html).drift).toBe(true);
  });
});

describe("rework 2 — a NAME_DRIFT row names both sides, and still groups", () => {
  it("the evidence rides in the message", async () => {
    const db = makeDb();
    await projectUrlHealthFlag(asDb(db), {
      sourceField: V,
      url: U,
      flag: "name_drift",
      present: true,
      checkedAt: D1,
      evidence: 'ours "Bay State Savings Bank" · site "Bay State Bank"',
    });
    const [row] = db.select().from(healthIssues).all();
    expect(row.message).toBe(
      'vendors.website names the business differently from our record · ours "Bay State Savings Bank" · site "Bay State Bank" · last checked 2026-10-02'
    );
  });

  it("two rows with different names fold to ONE Site Health group key", () => {
    const a =
      'vendors.website names the business differently from our record · ours "Bay State Savings Bank" · site "Bay State Bank" · last checked 2026-10-02';
    const b =
      'vendors.website names the business differently from our record · ours "Promethea Potters" · site "Promethea Arts" · last checked 2026-10-03';
    expect(normalizeHealthMessageKey(a)).toBe(normalizeHealthMessageKey(b));
  });

  it("the sweep passes the evidence, quoting both names", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/api/admin/url-health/vendors/sweep/route.ts"),
      "utf8"
    );
    expect(src).toMatch(/evidence:\s*\n?\s*v\.nameDrift\.drift === true/);
    expect(src).toContain('`ours "${');
  });
});

describe("rework 3 — 403 / 429 are a bot wall, not a broken site", () => {
  const site = "https://example-vendor.com/";
  it.each([403, 429])("HTTP %i → blocked, with a bot-wall signal", (status) => {
    const v = classifyVendorSite(
      { reachedOrigin: true, status, html: "Access denied", finalUrl: site },
      { requestedUrl: site, businessName: "X" }
    );
    expect(v.verdict).toBe("blocked");
    expect(v.signals).toEqual([`bot-wall:http_${status}`]);
  });

  it("404 / 530 stay http_error (a genuinely broken link)", () => {
    for (const status of [404, 530]) {
      expect(
        classifyVendorSite(
          { reachedOrigin: true, status, html: "x", finalUrl: site },
          { requestedUrl: site, businessName: "X" }
        ).verdict
      ).toBe("http_error");
    }
  });

  it("blocked is NOT queued, and closes an open http_error row for the URL", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), {
      sourceField: V,
      url: U,
      verdict: "http_error",
      httpStatus: 403,
      checkedAt: D1,
    });
    const r = await projectUrlHealthVerdict(asDb(db), {
      sourceField: V,
      url: U,
      verdict: "blocked",
      httpStatus: 403,
      checkedAt: D2,
    });
    expect(r.opened).toBe(0);
    const rows = db.select().from(healthIssues).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).not.toBeNull();
  });
});
