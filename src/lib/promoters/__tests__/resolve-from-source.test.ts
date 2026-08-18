/**
 * OPE-458 scope 3 — the promoter rail that never existed.
 *
 * Four events named "Vineyard Artisans …" were created from
 * `vineyardartisans.com` and assigned to `system-community-suggestions`, while a
 * promoter row called **Vineyard Artisans** already owned two of its other
 * festivals. OPE-201 normalizes the venue on auto-created events; nothing ever
 * did the same for the promoter, so the placeholder was the default rather than
 * the fallback.
 *
 * The governing asymmetry, which every test here is really about: assigning an
 * event to the WRONG promoter is worse than leaving it with the placeholder. A
 * wrong owner publishes on someone else's page and emits no signal; the
 * placeholder is merely visibly incomplete. So the rules fail closed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  COMMUNITY_PROMOTER_ID,
  hostOf,
  isNamePrefixMatch,
  resolvePromoterForSource,
} from "../resolve-from-source";

const SCHEMA_SQL = `
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY, company_name TEXT, slug TEXT, website TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(id: string, companyName: string, website: string | null = null) {
  raw
    .prepare(`INSERT INTO promoters (id, company_name, slug, website) VALUES (?,?,?,?)`)
    .run(id, companyName, id, website);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  seed(COMMUNITY_PROMOTER_ID, "Community Suggestions", null);
});

const VA = "0b9f735f-77bc-465e-9364-1f8625a25c08";

describe("the specimen", () => {
  beforeEach(() => seed(VA, "Vineyard Artisans", "https://vineyardartisans.com/"));

  it("matches on the source domain", async () => {
    const r = await resolvePromoterForSource(db, {
      sourceUrl: "https://vineyardartisans.com/festivals",
      eventName: "Some Festival",
    });
    expect(r?.promoterId).toBe(VA);
    expect(r?.basis).toBe("source_domain");
  });

  it("matches on the NAME when there is no source URL", async () => {
    // The four real events carry source_url = NULL because they came off the
    // body path (OPE-457). A domain-only rule would have looked principled and
    // fixed none of them.
    const r = await resolvePromoterForSource(db, {
      sourceUrl: null,
      eventName: "Vineyard Artisans Summer Festival",
    });
    expect(r?.promoterId).toBe(VA);
    expect(r?.basis).toBe("name_prefix");
  });

  it("ignores www. and scheme differences", async () => {
    const r = await resolvePromoterForSource(db, {
      sourceUrl: "http://www.vineyardartisans.com/x",
      eventName: "Unrelated",
    });
    expect(r?.promoterId).toBe(VA);
  });
});

describe("fails closed rather than guessing", () => {
  it("returns null when two promoters share a domain", async () => {
    seed("p1", "Vineyard Artisans", "https://vineyardartisans.com/");
    seed("p2", "Vineyard Artisans Guild", "https://vineyardartisans.com/");
    const r = await resolvePromoterForSource(db, {
      sourceUrl: "https://vineyardartisans.com/",
      eventName: "Something Else Entirely",
    });
    expect(r).toBeNull();
  });

  it("returns null when two promoters prefix-match the name", async () => {
    seed("p1", "Vineyard Artisans", null);
    seed("p2", "Vineyard Artisans Summer", null);
    const r = await resolvePromoterForSource(db, {
      sourceUrl: null,
      eventName: "Vineyard Artisans Summer Festival",
    });
    expect(r).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    seed(VA, "Vineyard Artisans", "https://vineyardartisans.com/");
    expect(
      await resolvePromoterForSource(db, {
        sourceUrl: "https://someone-else.example/",
        eventName: "Bangor Craft Fair",
      })
    ).toBeNull();
  });

  it("never returns the community placeholder itself", async () => {
    const r = await resolvePromoterForSource(db, {
      sourceUrl: null,
      eventName: "Community Suggestions Fall Fair",
    });
    expect(r?.promoterId).not.toBe(COMMUNITY_PROMOTER_ID);
  });
});

describe("the name-prefix guard", () => {
  it("requires a word boundary", () => {
    // "Vineyard Artisanship Expo" must NOT match "Vineyard Artisans".
    expect(isNamePrefixMatch("Vineyard Artisanship Expo", "Vineyard Artisans")).toBe(false);
    expect(isNamePrefixMatch("Vineyard Artisans Summer Festival", "Vineyard Artisans")).toBe(true);
  });

  it("rejects single-token promoter names", () => {
    // 9 of 697 promoters are single-token. Without this they would prefix-match
    // a large share of the catalog.
    expect(isNamePrefixMatch("Maine Blueberry Festival", "Maine")).toBe(false);
  });

  it("rejects short promoter names", () => {
    expect(isNamePrefixMatch("MV Fair 2026", "MV Fair")).toBe(false);
  });

  it("accepts an exact name equality", () => {
    expect(isNamePrefixMatch("Vineyard Artisans", "Vineyard Artisans")).toBe(true);
  });

  it("is punctuation- and case-insensitive", () => {
    expect(isNamePrefixMatch("VINEYARD  ARTISANS' Summer Fest", "Vineyard Artisans")).toBe(true);
  });
});

describe("hostOf", () => {
  it.each([
    ["https://www.vineyardartisans.com/x", "vineyardartisans.com"],
    ["http://VineyardArtisans.com", "vineyardartisans.com"],
    ["not-a-url", null],
    ["", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(hostOf(input as string | null)).toBe(expected);
  });
});
