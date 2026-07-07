import { describe, it, expect } from "vitest";
import {
  buildPerformerNodes,
  performerSchemaType,
  type ConfirmedAppearance,
} from "../event-jsonld";

const SITE = "https://meetmeatthefair.com";
const appr = (o: Partial<ConfirmedAppearance>): ConfirmedAppearance => ({
  name: o.name ?? "Act",
  slug: o.slug ?? "act",
  performerType: o.performerType ?? "PERSON",
  actCategory: o.actCategory ?? null,
  sameAs: o.sameAs ?? null,
  imageUrl: o.imageUrl ?? null,
  billing: o.billing ?? null,
  performanceStart: o.performanceStart ?? null,
});

describe("performerSchemaType (OPE-114)", () => {
  it("maps PERSON/GROUP/GROUP+MUSIC + defaults unknown to Person", () => {
    expect(performerSchemaType("PERSON", null)).toBe("Person");
    expect(performerSchemaType("GROUP", null)).toBe("PerformingGroup");
    expect(performerSchemaType("GROUP", "MUSIC")).toBe("MusicGroup");
    expect(performerSchemaType(null, "COMEDY")).toBe("Person");
  });
});

describe("buildPerformerNodes (OPE-114)", () => {
  it("returns undefined for no confirmed acts (caller omits the property)", () => {
    expect(buildPerformerNodes([], SITE)).toBeUndefined();
  });

  it("builds nodes with @type, url to our page, sameAs + image when present", () => {
    const nodes = buildPerformerNodes(
      [
        appr({
          name: "Mr. Drew",
          slug: "mr-drew-and-his-animals-too",
          performerType: "PERSON",
          billing: "HEADLINER",
          sameAs: "https://facebook.com/mrdrew",
          imageUrl: "https://cdn/mr-drew.webp",
        }),
      ],
      SITE
    );
    expect(nodes).toEqual([
      {
        "@type": "Person",
        name: "Mr. Drew",
        url: `${SITE}/performers/mr-drew-and-his-animals-too`,
        sameAs: "https://facebook.com/mrdrew",
        image: "https://cdn/mr-drew.webp",
      },
    ]);
  });

  it("DEDUPES a performer with multiple sets to a single who-list entry", () => {
    const nodes = buildPerformerNodes(
      [
        appr({ name: "Solo", slug: "solo", billing: "SUPPORTING", performanceStart: 1000 }),
        appr({ name: "Solo", slug: "solo", billing: "HEADLINER", performanceStart: 2000 }),
      ],
      SITE
    );
    expect(nodes).toHaveLength(1);
    expect(nodes![0].name).toBe("Solo");
  });

  it("orders by billing (headliner first), then name", () => {
    const nodes = buildPerformerNodes(
      [
        appr({ name: "Zed Opener", slug: "zed", billing: "SUPPORTING" }),
        appr({ name: "Ann Headliner", slug: "ann", billing: "HEADLINER" }),
        appr({ name: "Bob Featured", slug: "bob", billing: "FEATURED" }),
      ],
      SITE
    );
    expect(nodes!.map((n) => n.name)).toEqual(["Ann Headliner", "Bob Featured", "Zed Opener"]);
  });

  it("omits sameAs/image keys cleanly when absent", () => {
    const nodes = buildPerformerNodes(
      [appr({ name: "Plain", slug: "plain", performerType: "GROUP" })],
      SITE
    );
    expect(nodes![0]).toEqual({
      "@type": "PerformingGroup",
      name: "Plain",
      url: `${SITE}/performers/plain`,
    });
  });
});
