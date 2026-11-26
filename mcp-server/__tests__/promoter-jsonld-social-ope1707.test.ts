/**
 * OPE-1707 — RULING (John 2026-11-22): a promoter social payload read from the
 * site's own JSON-LD auto-applies again, gated on name affinity; a social
 * scraped from page anchors (`social-link`) stays held by the OPE-1295
 * promotable gate.
 *
 * Every case is a LIVE run through the real dispatcher with NO review history,
 * so the OPE-1295 gate is closed for every method: anything that applies did so
 * because of the jsonld path, and nothing else.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { promoters, promoterEnrichmentCandidates } from "../src/schema.js";
import {
  gateJsonLdSocial,
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://x",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

const jsonLd = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

let db: TestDb;
let restore: (() => void) | null = null;

function serve(html: string) {
  restore?.();
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  restore = () => (globalThis.fetch = orig);
}

beforeEach(async () => {
  ({ db } = createTestDb());
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Purity Spring Resort",
    slug: "purity-spring-resort",
    website: "https://www.purityspring.com/",
    state: "NH",
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
});
afterEach(() => {
  restore?.();
  restore = null;
});

const live = () =>
  processPromoterEnrichmentJob(db, ENV, { promoterId: "p1", jobRunId: "j-live", dryRun: false });
const promoter = async () => (await db.select().from(promoters).where(eq(promoters.id, "p1")))[0];
const social = async () =>
  (
    await db
      .select()
      .from(promoterEnrichmentCandidates)
      .where(
        and(
          eq(promoterEnrichmentCandidates.promoterId, "p1"),
          eq(promoterEnrichmentCandidates.proposedField, "social_links")
        )
      )
  )[0];

describe("OPE-1707 — jsonld socials auto-apply again, behind a name-affinity gate", () => {
  it("ACCEPTANCE: an affine jsonld payload auto-applies with no review history", async () => {
    serve(
      jsonLd({
        "@type": "Resort",
        sameAs: [
          "https://www.facebook.com/purityspringresort/",
          "https://www.instagram.com/purityspringresort/",
        ],
      })
    );
    const r = await live();
    expect(r.socialStagedNotPromotable).toBe(0);
    const row = await social();
    expect(row.extractionMethod).toBe("jsonld");
    expect(row.decision).toBe("auto_merged");
    expect(JSON.parse((await promoter()).socialLinks!).facebook).toBe(
      "https://www.facebook.com/purityspringresort/"
    );
  });

  it("ACCEPTANCE: a payload MIXING the promoter's and another business's accounts stages whole", async () => {
    serve(
      jsonLd({
        "@type": "Resort",
        sameAs: [
          "https://www.facebook.com/purityspringresort/",
          "https://www.instagram.com/highwaywestvacations",
        ],
      })
    );
    await live();
    const row = await social();
    expect(row.decision).toBe("pending");
    // An unaffine JSON-LD account also makes the page multi-entity (OPE-1706).
    expect(JSON.parse(row.flags).sort()).toEqual(
      ["jsonld_multiple_entities", "social_mixed_affinity"].sort()
    );
    expect((await promoter()).socialLinks ?? null).toBeNull();
  });

  it("ACCEPTANCE (Purity Spring): another business elsewhere in the JSON-LD holds even the promoter's own accounts", async () => {
    // Highway West's facebook loses the first-per-platform race, so the
    // extracted payload is Purity's alone; the page still names two businesses.
    serve(
      jsonLd([
        {
          "@type": "Organization",
          name: "Highway West Vacations",
          sameAs: ["https://www.facebook.com/HighwayWestVacations"],
        },
        {
          "@type": "Resort",
          name: "Purity Spring Resort",
          sameAs: ["https://www.facebook.com/purityspringresort/"],
        },
      ])
    );
    await live();
    const row = await social();
    expect(row.decision).toBe("pending");
    expect(JSON.parse(row.flags)).toContain("jsonld_multiple_entities");
    expect((await promoter()).socialLinks ?? null).toBeNull();
  });

  it("an unaffine jsonld payload stages with social_no_name_affinity (unchanged)", async () => {
    serve(
      jsonLd({ "@type": "Organization", sameAs: ["https://www.facebook.com/highwaywestvacations"] })
    );
    await live();
    const row = await social();
    expect(row.decision).toBe("pending");
    expect(JSON.parse(row.flags)).toEqual(["social_no_name_affinity"]);
  });

  it("ACCEPTANCE: a social-link (anchor) payload still stages — the OPE-1295 gate holds it", async () => {
    serve(`<footer><a href="https://www.facebook.com/purityspringresort/">Facebook</a></footer>`);
    const r = await live();
    expect(r.socialStagedNotPromotable).toBe(1);
    const row = await social();
    expect(row.extractionMethod).toBe("social-link");
    expect(row.decision).toBe("pending");
    expect((await promoter()).socialLinks ?? null).toBeNull();
  });

  it("gateJsonLdSocial leaves social-link proposals and already-unaffine jsonld ones alone", () => {
    const proposals = [
      {
        field: "social_links",
        method: "social-link",
        proposedValue: '{"facebook":"https://www.facebook.com/other"}',
        flags: [] as string[],
        autoApply: true,
      },
      {
        field: "social_links",
        method: "jsonld",
        proposedValue: '{"facebook":"https://www.facebook.com/other"}',
        flags: ["social_no_name_affinity"],
        autoApply: false,
      },
    ];
    gateJsonLdSocial(proposals, "Purity Spring Resort", "https://www.purityspring.com/", true);
    expect(proposals[0].flags).toEqual([]);
    expect(proposals[0].autoApply).toBe(true);
    expect(proposals[1].flags).toEqual(["social_no_name_affinity"]);
  });
});
