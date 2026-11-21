/**
 * OPE-1687 — og:image hero/logo classification for the three 2026-11-18
 * specimens, read against the images themselves:
 *   - Mad River Valley Craft Fair: a 4272×2848 photo, already the promoter's
 *     HERO since September, re-staged as its LOGO when the probe could not
 *     measure it. → never propose the current hero as the logo; and a Wix
 *     `_d_W_H` / `fill` URL states a reliable shape when the probe cannot.
 *   - Soule Homestead: `newsletter-graphic.png` staged as a logo. → banner /
 *     header / newsletter filenames are never logos.
 *   - Chandler Center: its og:image sits in a Wix `fit/w_2500,h_1330` box but
 *     MEASURES 500×500 (a square line-drawing mark). The fit box keeps the
 *     source aspect, so it is not shape evidence — a measured square stays a logo.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import { classifyPromoterImage, wixHintedDimensions } from "../src/enrichment/promoter-image.js";

const WIX_PHOTO =
  "https://static.wixstatic.com/media/50863c_cb32%7Emv2_d_4272_2848_s_4_2.jpg/v1/fit/w_2500,h_1330,al_c/50863c_cb32%7Emv2_d_4272_2848_s_4_2.jpg";
const WIX_FIT_SQUARE =
  "https://static.wixstatic.com/media/f4efc9_5913%7Emv2.png/v1/fit/w_2500,h_1330,al_c/f4efc9_5913%7Emv2.png";

describe("wixHintedDimensions", () => {
  it("reads the original-size token and fill crops, never the fit box", () => {
    expect(wixHintedDimensions(WIX_PHOTO)).toEqual({ width: 4272, height: 2848 });
    expect(
      wixHintedDimensions(
        "https://static.wixstatic.com/media/a%7Emv2.jpg/v1/fill/w_1200,h_630/a.jpg"
      )
    ).toEqual({ width: 1200, height: 630 });
    expect(wixHintedDimensions(WIX_FIT_SQUARE)).toBeNull();
  });
});

describe("classifyPromoterImage — OPE-1687", () => {
  it("an unmeasured Wix photo with a wide original-size token is a hero candidate, never confident", () => {
    expect(classifyPromoterImage(WIX_PHOTO, null)).toMatchObject({
      classification: "hero",
      heroConfident: false,
    });
  });

  it("an unmeasured Wix fit-box image with no reliable hint still defaults to logo", () => {
    expect(classifyPromoterImage(WIX_FIT_SQUARE, null).classification).toBe("logo");
  });

  it("Chandler: a fit-box image MEASURED square stays a logo", () => {
    expect(classifyPromoterImage(WIX_FIT_SQUARE, { width: 500, height: 500 }).classification).toBe(
      "logo"
    );
  });

  it("a genuinely square Wix logo (fit/w_500,h_500) stays a logo", () => {
    const u = "https://static.wixstatic.com/media/x%7Emv2.png/v1/fit/w_500,h_500/x.png";
    expect(classifyPromoterImage(u, null).classification).toBe("logo");
    expect(classifyPromoterImage(u, { width: 500, height: 500 }).classification).toBe("logo");
  });

  it("Soule: a newsletter/banner/header filename is never a logo, measured or not", () => {
    const u = "https://soule.example.org/wp-content/uploads/2016/11/newsletter-graphic.png";
    expect(classifyPromoterImage(u, null)).toMatchObject({
      classification: "hero",
      heroConfident: false,
    });
    expect(classifyPromoterImage(u, { width: 600, height: 600 })).toMatchObject({
      classification: "hero",
      heroConfident: false,
    });
    // A directory named like the token does not count; only the filename.
    expect(
      classifyPromoterImage("https://x.example.org/headers/brand.png", null).classification
    ).toBe("logo");
    // An explicit logo token still wins.
    expect(
      classifyPromoterImage("https://x.example.org/header-logo.png", null).classification
    ).toBe("logo");
  });
});

// ── dispatcher: the current hero is never re-proposed as the logo ──────────
const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://meetmeatthefair.com",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;
const HOST = "madriver.example.com";
const IMG = `https://${HOST}/media/og-share.jpg`; // no hint, no token → unmeasured ⇒ "logo"

let db: TestDb;
let indexNow: ReturnType<typeof mockIndexNowFetch>;
let restoreFetch: (() => void) | null = null;

beforeEach(async () => {
  ({ db } = createTestDb());
  indexNow = mockIndexNowFetch();
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === HOST) {
      if (url.pathname === "/") {
        return new Response(
          `<html><head><meta property="og:image" content="${IMG}"></head></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html" },
          }
        );
      }
      return new Response("gone", { status: 404 }); // the image cannot be measured
    }
    return orig(input, init);
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = orig);
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  indexNow.restore();
});

async function seed(heroImageUrl: string | null) {
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Mad River Valley Craft Fair",
    slug: "mad-river-valley-craft-fair",
    website: `https://${HOST}/`,
    heroImageUrl,
    contactEmail: "info@madriver-fixture.org",
    contactPhone: "(802) 555-0100",
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
}
const logoRows = () =>
  db
    .select()
    .from(promoterEnrichmentCandidates)
    .where(eq(promoterEnrichmentCandidates.proposedField, "logo"));
const run = () =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: "p1", jobRunId: "j1", dryRun: true });

describe("OPE-1687 — the current hero is not the logo", () => {
  it("landmark: with no hero on file, the unmeasured og:image DOES stage as a logo", async () => {
    await seed(null);
    await run();
    expect((await logoRows()).map((r) => r.proposedValue)).toEqual([IMG]);
  });

  it("ACCEPTANCE (Mad River): the URL already serving as the hero is not staged as the logo", async () => {
    await seed(IMG);
    await run();
    expect(await logoRows()).toHaveLength(0);
  });
});
