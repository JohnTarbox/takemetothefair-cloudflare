/**
 * OPE-856 — a mailbox provider is not a business name.
 *
 * `senderNameVariants("someone@gmail.com")` contributed both `gmail` and
 * `gmail.com`. `brandKey("gmail.com")` is `"gmailcom"` — eight characters, so
 * it cleared the fragment matcher's six-character gate — and it
 * substring-matched the vendor whose `businessName` is the bare address
 * `craftigalcreative@gmail.com`.
 *
 * **6 of 12** real inbound emails in the 2026-09-09 audit census carried that
 * false "existing vendor" match.
 *
 * ## ⚠️ Amendment H
 *
 * "A gmail sender matches nothing" is satisfied by a matcher that matches
 * NOTHING — which would silently destroy every real vendor lookup on the
 * briefing path. So each negative case sits beside a positive one on the same
 * fixture set, and the real-domain regression (`freedomboatclub.us`) is
 * asserted explicitly because the ticket names it as the thing that must not
 * break.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { senderNameVariants, matchVendorByVariants } from "../src/inbound/vendor-inquiry-briefing";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY, business_name TEXT NOT NULL, display_name TEXT,
    slug TEXT NOT NULL, website TEXT, deleted_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(id: string, businessName: string, website: string | null = null) {
  raw
    .prepare(
      `INSERT INTO vendors (id, business_name, slug, website, deleted_at) VALUES (?,?,?,?,NULL)`
    )
    .run(id, businessName, id, website);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw);
});

describe("OPE-856 — senderNameVariants drops mailbox providers", () => {
  it("REGRESSION: a gmail sender contributes NO domain variants", () => {
    expect(senderNameVariants("joe@gmail.com")).toEqual([]);
  });

  it("drops the bare label too, not just the full domain", () => {
    // `gmail` alone is five chars and would fail the fragment gate today, but
    // it still reaches the exact and brand-key matchers above it — and a
    // vendor literally named "Gmail" is not the sender's business either.
    expect(senderNameVariants("joe@gmail.com")).not.toContain("gmail");
    expect(senderNameVariants("joe@gmail.com")).not.toContain("gmail.com");
  });

  it("keeps the signature name — that IS evidence about who is writing", () => {
    expect(senderNameVariants("joe@gmail.com", "Joe's Woodworks")).toEqual(["Joe's Woodworks"]);
  });

  it("a REAL business domain is untouched — the landmark", () => {
    // Without this the tests above are satisfied by returning [] for
    // everything, which would delete the feature.
    const v = senderNameVariants("info@freedomboatclub.us");
    expect(v).toContain("freedomboatclub");
    expect(v).toContain("freedomboatclub.us");
  });

  it.each([
    "outlook.com",
    "hotmail.com",
    "yahoo.com",
    "aol.com",
    "icloud.com",
    "msn.com",
    "comcast.net",
    "proton.me",
  ])("%s is treated as a provider, not a brand", (domain) => {
    expect(senderNameVariants(`someone@${domain}`)).toEqual([]);
  });
});

describe("OPE-856 — the matcher no longer lands on craftigalcreative", () => {
  beforeEach(() => {
    // The real row: businessName is itself a bare gmail address.
    seed("8290caae", "craftigalcreative@gmail.com");
    seed("fbc", "Freedom Boat Club", "https://freedomboatclub.us");
    seed("baf", "Before A Fall");
  });

  it("REGRESSION: a gmail sender with no other signal matches NOTHING", async () => {
    const r = await matchVendorByVariants(db, senderNameVariants("joe@gmail.com"));
    expect(r.match).toBeNull();
  });

  it("…and the craftigalcreative row really is present and would have matched", async () => {
    // ⚠️ The landmark that makes the assertion above mean something. Feeding
    // the pre-fix variant directly proves the row is seeded, is fragment-shaped,
    // and is now excluded on its own merits (scope 2) rather than because the
    // table is empty.
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM vendors`).get()).toEqual({ n: 3 });
    const r = await matchVendorByVariants(db, ["gmail.com"]);
    expect(r.match).toBeNull();
  });

  it("a real domain still matches on website-domain", async () => {
    const r = await matchVendorByVariants(db, senderNameVariants("info@freedomboatclub.us"));
    expect(r.match?.id).toBe("fbc");
  });

  it("an exact business-name match still resolves", async () => {
    const r = await matchVendorByVariants(db, senderNameVariants("x@gmail.com", "Before A Fall"));
    expect(r.match?.id).toBe("baf");
    expect(r.match?.matchedVariant).toBe("exact");
  });

  it("a legitimate fragment match still fires — the gate is not now closed", async () => {
    // Scope 2 excludes only bare-provider-address businessNames. An ordinary
    // vendor must still be fragment-reachable, or this change traded one
    // wrong answer for no answers.
    seed("tp", "TIMEPROOFUSA LLC");
    const r = await matchVendorByVariants(db, ["timeproofusa"]);
    expect(r.match?.id).toBe("tp");
    // I first expected "brand-key" here and was wrong: the despaced column is
    // "timeproofusallc", so the key comparison misses and the FRAGMENT arm is
    // what fires. That makes this a better test than intended — it proves the
    // fragment path is still live, which is the exact thing scope 2 could have
    // broken.
    expect(r.match?.matchedVariant).toBe("fragment");
  });

  it("a bare-provider vendor is skipped but a real one behind it still wins", async () => {
    // The filter takes the first USABLE row, not merely the first row — so a
    // bare-address vendor sorting ahead of a real one must not swallow the
    // match. This is the case a naive `.limit(1)` + reject would lose.
    seed("bare", "handmadegoods@gmail.com");
    seed("real", "Handmade Goods Co");
    const r = await matchVendorByVariants(db, ["handmadegoods"]);
    expect(r.match?.id).toBe("real");
  });
});
