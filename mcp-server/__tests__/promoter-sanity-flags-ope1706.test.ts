/**
 * OPE-1706 — four cheap sanity checks on promoter-enrichment proposals.
 *
 * Unit tests for each check (with the pass cases the ticket names: toll-free,
 * the promoter's own logo domain, info@), then the four 2026-11-22 specimens
 * driven through the real dispatcher on LIVE runs, so "stages instead of
 * auto-applying" is read back from the promoter row and the candidate's
 * decision, not inferred from a flag.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";
import {
  jsonLdHasMultipleEntities,
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import {
  applyPromoterSanityFlags,
  areaCodeOf,
  emailOnOwnDomain,
  flagReasons,
  isRoleAddress,
  logoOffsite,
  logoStockPhoto,
  phoneRegionMismatch,
  type SanityProposal,
} from "../src/enrichment/promoter-sanity.js";
import { jsonLdIdentitySummary } from "../src/enrichment/extract.js";

describe("OPE-1706 — unit checks", () => {
  it("areaCodeOf reads NANP numbers with or without a country code", () => {
    expect(areaCodeOf("(605) 367-8896")).toBe("605");
    expect(areaCodeOf("+1 207 555 0100")).toBe("207");
    expect(areaCodeOf("555-0100")).toBeNull();
  });

  it("phone region: wrong-region flags, in-state and toll-free pass", () => {
    expect(phoneRegionMismatch("(605) 367-8896", "NH")).toBe(true); // Purity Spring
    expect(phoneRegionMismatch("(949) 783-2555", "NH")).toBe(true);
    expect(phoneRegionMismatch("(603) 367-8896", "NH")).toBe(false);
    expect(phoneRegionMismatch("(207) 555-0123", "ME")).toBe(false); // Maine landmark
    expect(phoneRegionMismatch("(855) 650-0080", "VT")).toBe(false); // Hotel Vermont
    expect(phoneRegionMismatch("(617) 555-0123", "ma")).toBe(false); // case-insensitive state
    expect(phoneRegionMismatch("(413) 555-0123", "CT")).toBe(true);
  });

  it("phone region: no state, or a state outside New England, never flags", () => {
    expect(phoneRegionMismatch("(605) 367-8896", null)).toBe(false);
    expect(phoneRegionMismatch("(605) 367-8896", "")).toBe(false);
    expect(phoneRegionMismatch("(212) 555-0123", "NY")).toBe(false);
  });

  it("role address: the listed local parts flag; info@/contact@/hello@ pass", () => {
    for (const e of [
      "hotline@portsmouthnh.gov",
      "webmaster@x.org",
      "no-reply@x.org",
      "HR@x.org",
      "billing@x.org",
    ]) {
      expect(isRoleAddress(e), e).toBe(true);
    }
    for (const e of ["info@purityspring.com", "contact@x.org", "hello@x.org", "hrsmith@x.org"]) {
      expect(isRoleAddress(e), e).toBe(false);
    }
  });

  it("logo offsite: own website domain and builder CDNs pass, a third domain flags", () => {
    const own = ["https://www.nhfestivaloftrees.com/"];
    expect(
      logoOffsite(
        "https://www.nhfestivaloftrees.com/uploads/3/9/6/4/39649307/festival-of-trees-logo_orig.png",
        own
      )
    ).toBe(false); // Carroll County RSVP
    expect(logoOffsite("https://static.wixstatic.com/media/a.png", own)).toBe(false);
    expect(logoOffsite("https://images.squarespace-cdn.com/a.png", own)).toBe(false);
    expect(logoOffsite("https://i0.wp.com/x.org/a.png", own)).toBe(false);
    expect(logoOffsite("https://img1.wsimg.com/a.png", own)).toBe(false);
    expect(logoOffsite("https://lh3.googleusercontent.com/a", own)).toBe(false);
    expect(logoOffsite("https://cdn.shopify.com/s/files/a.png", own)).toBe(false);
    expect(logoOffsite("https://cdn.nhfestivaloftrees.com/a.png", own)).toBe(false); // subdomain
    expect(logoOffsite("https://www.othercharity.org/logo.png", own)).toBe(true);
    // The page the fetch landed on counts as the promoter's own site too.
    expect(
      logoOffsite("https://new.example.org/logo.png", [
        "https://old.example.com",
        "https://new.example.org/",
      ])
    ).toBe(false);
  });

  it("logo stock photo: the jumpstory specimen and the other services flag", () => {
    expect(
      logoStockPhoto(
        "https://loveburlington.org/assets/image-cache/jumpstory_download20200604_141649.999098aa.jpg"
      )
    ).toBe(true);
    expect(logoStockPhoto("https://images.unsplash.com/photo-1.jpg")).toBe(true);
    expect(logoStockPhoto("https://x.org/uploads/iStock-123.jpg")).toBe(true);
    expect(logoStockPhoto("https://x.org/uploads/logo.png")).toBe(false);
  });

  it("emailOnOwnDomain", () => {
    expect(emailOnOwnDomain("info@purityspring.com", "https://www.purityspring.com/")).toBe(true);
    expect(emailOnOwnDomain("info@highwaywest.com", "https://www.purityspring.com/")).toBe(false);
  });

  it("jsonld_multiple_entities: flags JSON-LD contacts only, exempts an own-domain email", () => {
    const proposals: SanityProposal[] = [
      {
        field: "contact_phone",
        proposedValue: "(603) 367-8896",
        method: "jsonld",
        flags: [],
        autoApply: true,
      },
      {
        field: "contact_email",
        proposedValue: "info@purityspring.com",
        method: "jsonld",
        flags: [],
        autoApply: true,
      },
      {
        field: "contact_email",
        proposedValue: "sales@highwaywest.com",
        method: "jsonld",
        flags: [],
        autoApply: true,
      },
      {
        field: "contact_phone",
        proposedValue: "(603) 111-2222",
        method: "tel",
        flags: [],
        autoApply: true,
      },
    ];
    applyPromoterSanityFlags(proposals, {
      state: "NH",
      website: "https://www.purityspring.com/",
      jsonLdMultipleEntities: true,
    });
    expect(proposals.map((p) => [p.flags, p.autoApply])).toEqual([
      [["jsonld_multiple_entities"], false],
      [[], true],
      [["jsonld_multiple_entities"], false],
      [[], true],
    ]);
  });

  it("flagReasons gives every flag a line, including unknown ones", () => {
    const r = flagReasons(["phone_region_mismatch", "logo_stock_photo", "mystery_flag"]);
    expect(Object.keys(r)).toEqual(["phone_region_mismatch", "logo_stock_photo", "mystery_flag"]);
    for (const v of Object.values(r)) expect(v.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Through the real dispatcher.
// ---------------------------------------------------------------------------

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://meetmeatthefair.com",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

let db: TestDb;
let indexNow: ReturnType<typeof mockIndexNowFetch>;
let restoreFetch: (() => void) | null = null;

/** Serve `pages[url-prefix]` as HTML; any other request on a test host is a 404 (so an og:image probes as an unmeasurable logo). */
function serve(pages: Record<string, string>) {
  restoreFetch?.();
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.keys(pages).find((k) => url === k || url === `${k}/`);
    if (hit) {
      return new Response(pages[hit], { status: 200, headers: { "content-type": "text/html" } });
    }
    if (/\.(example|test)\b|loveburlington|nhfestivaloftrees|purityspring|portsmouthnh/.test(url)) {
      return new Response("nope", { status: 404 });
    }
    return orig(input, init);
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = orig);
}

beforeEach(() => {
  ({ db } = createTestDb());
  indexNow = mockIndexNowFetch();
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  indexNow.restore();
});

async function addPromoter(id: string, companyName: string, website: string, state: string) {
  await db.insert(promoters).values({
    id,
    companyName,
    slug: id,
    website,
    state,
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
}

const run = (promoterId: string, dryRun = false) =>
  processPromoterEnrichmentJob(db, ENV, { promoterId, jobRunId: `j-${Math.random()}`, dryRun });

async function candidate(promoterId: string, field: string) {
  const rows = await db
    .select()
    .from(promoterEnrichmentCandidates)
    .where(eq(promoterEnrichmentCandidates.promoterId, promoterId));
  return rows.find((r) => r.proposedField === field);
}

async function promoterRow(id: string) {
  return (await db.select().from(promoters).where(eq(promoters.id, id)))[0];
}

const jsonLd = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe("OPE-1706 — specimens through the dispatcher", () => {
  it("ACCEPTANCE: Purity Spring's 605 phone stages with both flags; its own-domain info@ still auto-applies", async () => {
    const site = "https://www.purityspring.com";
    await addPromoter("purity", "Purity Spring Resort", `${site}/`, "NH");
    serve({
      [site]: `<html><head>${jsonLd([
        {
          "@type": "Resort",
          name: "Purity Spring Resort",
          telephone: "605-367-8896",
          email: "info@purityspring.com",
          sameAs: ["https://www.facebook.com/purityspringresort/"],
        },
        {
          "@type": "Organization",
          name: "Highway West Vacations",
          telephone: "949-783-2555",
          sameAs: [
            "https://www.facebook.com/HighwayWestVacations",
            "https://www.instagram.com/highwaywestvacations",
          ],
        },
      ])}</head><body>Welcome</body></html>`,
    });

    await run("purity");
    const phone = await candidate("purity", "contact_phone");
    // parseJsonLdNodes walks a stack, so which node's phone wins is an order
    // detail; both are wrong-region for an NH promoter.
    expect(["(605) 367-8896", "(949) 783-2555"]).toContain(phone?.proposedValue);
    expect(JSON.parse(phone!.flags).sort()).toEqual(
      ["jsonld_multiple_entities", "phone_region_mismatch"].sort()
    );
    expect(phone?.decision).toBe("pending");

    // Positive landmark: the same page's own-domain email auto-applied.
    const email = await candidate("purity", "contact_email");
    expect(email?.proposedValue).toBe("info@purityspring.com");
    expect(JSON.parse(email!.flags)).toEqual([]);
    expect(email?.decision).toBe("auto_merged");

    const row = await promoterRow("purity");
    expect(row.contactPhone).toBeNull();
    expect(row.contactEmail).toBe("info@purityspring.com");
  });

  it("ACCEPTANCE: City of Portsmouth's hotline@ from the Contact page stages with email_role_address", async () => {
    const site = "https://www.portsmouthnh.gov";
    await addPromoter("ports", "City of Portsmouth", `${site}/`, "NH");
    serve({
      [site]: `<html><body><a href="/city/contact-connect">Contact</a></body></html>`,
      [`${site}/city/contact-connect`]: `<html><body><a href="mailto:hotline@portsmouthnh.gov">Hotline</a></body></html>`,
    });

    await run("ports");
    const email = await candidate("ports", "contact_email");
    expect(email?.proposedValue).toBe("hotline@portsmouthnh.gov");
    expect(JSON.parse(email!.flags)).toContain("email_role_address");
    expect(email?.decision).toBe("pending");
    expect((await promoterRow("ports")).contactEmail).toBeNull();
  });

  it("ACCEPTANCE: Love Burlington's jumpstory image stages as a logo with logo_stock_photo", async () => {
    const site = "https://loveburlington.org";
    await addPromoter("love", "Love Burlington", `${site}/`, "VT");
    const img = `${site}/assets/image-cache/jumpstory_download20200604_141649.999098aa.jpg`;
    serve({
      [site]: `<html><head><meta property="og:image" content="${img}"></head><body></body></html>`,
    });

    await run("love", true);
    const logo = await candidate("love", "logo");
    expect(logo?.proposedValue).toBe(img);
    expect(JSON.parse(logo!.flags)).toEqual(["logo_stock_photo"]);
  });

  it("ACCEPTANCE: Carroll County RSVP's Festival of Trees logo is on its own website, so NO logo_offsite", async () => {
    const site = "https://www.nhfestivaloftrees.com";
    await addPromoter("rsvp", "Carroll County RSVP", `${site}/`, "NH");
    const img = `${site}/uploads/3/9/6/4/39649307/festival-of-trees-logo_orig.png`;
    serve({
      [site]: `<html><head><meta property="og:image" content="${img}"></head><body></body></html>`,
    });

    await run("rsvp", true);
    const logo = await candidate("rsvp", "logo");
    expect(logo?.proposedValue).toBe(img); // landmark: the logo really staged
    expect(JSON.parse(logo!.flags)).toEqual([]);
  });

  it("an og:image on a third-party domain stages with logo_offsite", async () => {
    const site = "https://www.carrollrsvp.test";
    await addPromoter("rsvp2", "Carroll County RSVP", `${site}/`, "NH");
    const img = "https://www.othercharity.example/logo.png";
    serve({
      [site]: `<html><head><meta property="og:image" content="${img}"></head><body></body></html>`,
    });

    await run("rsvp2", true);
    expect(JSON.parse((await candidate("rsvp2", "logo"))!.flags)).toEqual(["logo_offsite"]);
  });

  it("LANDMARK: a toll-free tel: number and a 207 number for a Maine promoter still auto-apply", async () => {
    await addPromoter("hv", "Hotel Vermont", "https://hotelvermont.test/", "VT");
    await addPromoter("me", "Maine Craft Show", "https://mainecraft.test/", "ME");
    serve({
      "https://hotelvermont.test": `<html><body><a href="tel:+18556500080">Call</a></body></html>`,
      "https://mainecraft.test": `<html><body><a href="tel:207-555-0123">Call</a></body></html>`,
    });

    await run("hv");
    await run("me");
    expect((await promoterRow("hv")).contactPhone).toBe("(855) 650-0080");
    expect((await promoterRow("me")).contactPhone).toBe("(207) 555-0123");
    expect((await candidate("hv", "contact_phone"))?.decision).toBe("auto_merged");
  });

  it("REAL SHAPE (Purity Spring, deployed-build miss): a second business NESTED as parentOrganization is found", () => {
    // Structure read from purityspring.com on 2026-11-23: one top-level node,
    // with Highway West nested inside it — not a second top-level node.
    const html = jsonLd({
      "@context": "https://schema.org",
      "@type": "Resort",
      name: "Purity Spring Resort",
      telephone: "605-367-8896",
      sameAs: [
        "https://www.facebook.com/purityspringresort/",
        "https://www.instagram.com/purityspringresort/?hl=en",
      ],
      parentOrganization: {
        "@type": "Organization",
        name: "Highway West Vacations",
        telephone: "949-783-2555",
        sameAs: [
          "https://www.facebook.com/HighwayWestVacations/",
          "https://www.linkedin.com/company/highway-west-vacations/",
        ],
      },
    });
    expect(jsonLdIdentitySummary(html).phones.sort()).toEqual(["(605) 367-8896", "(949) 783-2555"]);
    expect(
      jsonLdHasMultipleEntities(html, "Purity Spring Resort", "https://www.purityspring.com/")
    ).toBe(true);
  });

  it("a clean single-business JSON-LD is not multi-entity; opaque handles are not evidence", () => {
    const html = jsonLd({
      "@type": "Organization",
      telephone: "603-555-0100",
      sameAs: [
        "https://www.facebook.com/purityspringresort/",
        "https://www.youtube.com/channel/UCLn8aDb85tYvYabcdefghij",
        "https://www.facebook.com/profile.php?id=1234567890",
      ],
    });
    expect(
      jsonLdHasMultipleEntities(html, "Purity Spring Resort", "https://www.purityspring.com/")
    ).toBe(false);
    // Two distinct phones = two businesses, even with no socials.
    const two = jsonLd([{ telephone: "603-555-0100" }, { telephone: "603-555-0199" }]);
    expect(
      jsonLdHasMultipleEntities(two, "Purity Spring Resort", "https://www.purityspring.com/")
    ).toBe(true);
    // The same phone repeated across nodes counts once.
    const same = jsonLd([{ telephone: "603-555-0100" }, { telephone: "(603) 555-0100" }]);
    expect(
      jsonLdHasMultipleEntities(same, "Purity Spring Resort", "https://www.purityspring.com/")
    ).toBe(false);
  });
});
