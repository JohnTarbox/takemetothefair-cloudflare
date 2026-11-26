/**
 * OPE-1714 — two more logo flags, extending OPE-1706 check 4:
 *   logo_other_org_name — a sponsor's logo on the promoter's OWN site
 *   logo_favicon        — a favicon staged as a logo (by name, or < 128px)
 *
 * Logos never auto-apply, so these flags only tell the reviewer why to look.
 * Specimens are the 2026-11-26 drain rows from the analyst comment on OPE-1706.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";
import {
  logoFavicon,
  logoOtherOrgName,
  flagReasons,
  applyPromoterSanityFlags,
} from "../src/enrichment/promoter-sanity.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";

describe("OPE-1714 — logoOtherOrgName", () => {
  it.each([
    // Specimen: North Shore Pride's own site, a bank's logo.
    [
      "https://northshorepride.org/wp-content/uploads/2024/06/Eastern-Bank-Logo.jpg",
      "North Shore Pride",
      "https://northshorepride.org/",
      true,
    ],
    // A sponsor / partner path flags whatever the filename says.
    [
      "https://pinehill.example/sponsors/acme.png",
      "Pine Hill Fair",
      "https://pinehill.example",
      true,
    ],
    [
      "https://pinehill.example/img/partner-logos/x.png",
      "Pine Hill Fair",
      "https://pinehill.example",
      true,
    ],
    // POSITIVE LANDMARKS — the promoter's own logo never flags.
    [
      "https://northshorepride.org/uploads/North-Shore-Pride-Logo.png",
      "North Shore Pride",
      "https://northshorepride.org/",
      false,
    ],
    // Name is inside the domain label, not the company name.
    [
      "https://www.nhfestivaloftrees.com/uploads/3/9/6/4/39649307/festival-of-trees-logo_orig.png",
      "Carroll County RSVP",
      "https://www.nhfestivaloftrees.com/",
      false,
    ],
    // Initials.
    [
      "https://northshorepride.org/uploads/nsp-logo.png",
      "North Shore Pride",
      "https://northshorepride.org/",
      false,
    ],
    // Nothing naming anyone: noise words, sizes, WordPress suffixes.
    [
      "https://x.example/wp-content/uploads/logo-white-1024x512-scaled.png",
      "Pine Hill Fair",
      "https://x.example",
      false,
    ],
    ["https://x.example/logo.png", "Pine Hill Fair", "https://x.example", false],
    // Not a logo filename at all → not this check's business.
    ["https://x.example/uploads/eastern-bank.jpg", "Pine Hill Fair", "https://x.example", false],
  ])("%s (%s) → %s", (url, name, site, want) => {
    expect(logoOtherOrgName(url, name, site)).toBe(want);
  });
});

describe("OPE-1714 — logoFavicon", () => {
  it.each([
    ["https://clarkfarms.com/wp-content/uploads/2025/08/clark-farms-favicon.svg", null, null, true],
    ["https://edge.growthzonecms.com/sites/59/2023/06/favicon.png", null, null, true],
    ["https://x.example/apple-touch-icon.png", null, null, true],
    ["https://x.example/logo.png", 32, 32, true],
    ["https://x.example/logo.png", 400, 120, true], // short side < 128
    // POSITIVE LANDMARKS
    ["https://x.example/logo.png", 512, 512, false],
    ["https://x.example/logo.png", 128, 300, false], // exactly at the floor
    ["https://x.example/logo.png", null, null, false], // unmeasured, unnamed
  ])("%s %sx%s → %s", (url, w, h, want) => {
    expect(logoFavicon(url, w, h)).toBe(want);
  });

  it("both flags carry a reason line", () => {
    const r = flagReasons(["logo_other_org_name", "logo_favicon"]);
    expect(r.logo_other_org_name).toMatch(/sponsor/);
    expect(r.logo_favicon).toMatch(/favicon/);
  });

  it("applyPromoterSanityFlags only flags logos, never other fields", () => {
    const p = [
      {
        field: "hero",
        proposedValue: "https://x.example/favicon.png",
        method: "og-image",
        flags: [],
        autoApply: true,
      },
    ];
    applyPromoterSanityFlags(p, {
      state: "ME",
      website: "https://x.example",
      name: "X",
      jsonLdMultipleEntities: false,
    });
    expect(p[0].flags).toEqual([]);
    expect(p[0].autoApply).toBe(true);
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

/** A minimal PNG whose IHDR says width×height (all the probe reads). */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

let db: TestDb;
let indexNow: ReturnType<typeof mockIndexNowFetch>;
let restoreFetch: (() => void) | null = null;

function serve(pages: Record<string, string>, images: Record<string, Uint8Array> = {}) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (images[url]) {
      return new Response(images[url], { status: 206, headers: { "content-type": "image/png" } });
    }
    const hit = Object.keys(pages).find((k) => url === k || url === `${k}/`);
    if (hit) {
      return new Response(pages[hit], { status: 200, headers: { "content-type": "text/html" } });
    }
    if (/\.(example|org|com)\b/.test(url)) return new Response("nope", { status: 404 });
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

async function logoCandidate(promoterId: string) {
  const rows = await db
    .select()
    .from(promoterEnrichmentCandidates)
    .where(eq(promoterEnrichmentCandidates.promoterId, promoterId));
  return rows.find((r) => r.proposedField === "logo");
}

const ogPage = (img: string) =>
  `<html><head><meta property="og:image" content="${img}"></head><body></body></html>`;

describe("OPE-1714 — specimens through the dispatcher", () => {
  it("ACCEPTANCE: North Shore Pride's Eastern Bank logo stages with logo_other_org_name", async () => {
    const site = "https://northshorepride.org";
    const img = `${site}/wp-content/uploads/2024/06/Eastern-Bank-Logo.jpg`;
    await addPromoter("nsp", "North Shore Pride", `${site}/`, "MA");
    serve({ [site]: ogPage(img) });
    await processPromoterEnrichmentJob(db, ENV, {
      promoterId: "nsp",
      jobRunId: "j1",
      dryRun: true,
    });
    const logo = await logoCandidate("nsp");
    expect(logo?.proposedValue).toBe(img);
    expect(JSON.parse(logo!.flags)).toEqual(["logo_other_org_name"]);
  });

  it("ACCEPTANCE: Clark Farms' favicon stages with logo_favicon", async () => {
    const site = "https://clarkfarms.com";
    const img = `${site}/wp-content/uploads/2025/08/clark-farms-favicon.svg`;
    await addPromoter("clark", "Clark Farms", `${site}/`, "CT");
    serve({ [site]: ogPage(img) });
    await processPromoterEnrichmentJob(db, ENV, {
      promoterId: "clark",
      jobRunId: "j2",
      dryRun: true,
    });
    const logo = await logoCandidate("clark");
    expect(logo?.proposedValue).toBe(img);
    expect(JSON.parse(logo!.flags)).toEqual(["logo_favicon"]);
  });

  it("a measured 32×32 og:image stages with logo_favicon (the size half)", async () => {
    const site = "https://pinehillfair.org";
    const img = `${site}/img/pine-hill-fair-mark.png`;
    await addPromoter("pine", "Pine Hill Fair", `${site}/`, "ME");
    serve({ [site]: ogPage(img) }, { [img]: pngHeader(32, 32) });
    await processPromoterEnrichmentJob(db, ENV, {
      promoterId: "pine",
      jobRunId: "j3",
      dryRun: true,
    });
    const logo = await logoCandidate("pine");
    expect(logo?.proposedValue).toBe(img);
    expect(JSON.parse(logo!.flags)).toEqual(["logo_favicon"]);
  });

  it("POSITIVE LANDMARK: the promoter's own 512px <name>-logo.png stages with neither flag", async () => {
    const site = "https://pinehillfair.org";
    const img = `${site}/img/pine-hill-fair-logo.png`;
    await addPromoter("pine2", "Pine Hill Fair", `${site}/`, "ME");
    serve({ [site]: ogPage(img) }, { [img]: pngHeader(512, 512) });
    await processPromoterEnrichmentJob(db, ENV, {
      promoterId: "pine2",
      jobRunId: "j4",
      dryRun: true,
    });
    const logo = await logoCandidate("pine2");
    expect(logo?.proposedValue).toBe(img); // the logo really staged
    expect(JSON.parse(logo!.flags)).toEqual([]);
  });
});
