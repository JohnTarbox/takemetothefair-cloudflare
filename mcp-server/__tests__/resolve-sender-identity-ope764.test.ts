/**
 * OPE-764 — the sender-recognition replay.
 *
 * The acceptance criterion is explicit that the five domains must reproduce
 * "by the tool rather than by hand", so these seed the real rows and run the
 * real resolver. Names, domains and URLs below are the production values read
 * from D1 on 2026-09-02, not invented fixtures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { resolveSenderIdentity, senderDomain } from "../src/inbound/resolve-sender-identity.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];

function vendor(id: string, name: string, website: string | null, email: string | null = null) {
  // `vendors.user_id` is NOT NULL *and* UNIQUE — one vendor per user — so each
  // fixture gets its own owner rather than sharing one.
  raw["prepare"](`INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Owner', 'VENDOR')`).run(
    `u-${id}`,
    `owner-${id}@example.com`
  );
  raw["prepare"](
    `INSERT INTO vendors (id, user_id, business_name, slug, website, contact_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
  ).run(id, `u-${id}`, name, id, website, email);
}
function promoter(id: string, name: string, website: string | null, email: string | null = null) {
  raw["prepare"](
    `INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Owner', 'PROMOTER')`
  ).run(`u-${id}`, `owner-${id}@example.com`);
  raw["prepare"](
    `INSERT INTO promoters (id, user_id, company_name, slug, website, contact_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(id, `u-${id}`, name, id, website, email);
}
function event(id: string, name: string, sourceUrl: string) {
  raw["prepare"](
    `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url)
     VALUES (?, ?, ?, 'p-x', 0, 0, 'APPROVED', ?)`
  ).run(id, name, id, sourceUrl);
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  promoter("p-x", "Filler Promoter", null);
});

describe("senderDomain", () => {
  it("strips the mail-host labels a sender cannot control", () => {
    expect(senderDomain("a@mail.example.com")).toBe("example.com");
    expect(senderDomain("a@WWW.Example.COM")).toBe("example.com");
  });

  it("returns null for something that is not an address", () => {
    expect(senderDomain("not-an-address")).toBeNull();
    expect(senderDomain("a@localhost")).toBeNull();
  });
});

describe("OPE-764 — the five-domain replay, by the tool", () => {
  it("recognises Jeremy Hall (CT DEEP) via portal.ct.gov — and NOT the four municipal domains", async () => {
    // The real rows. `portal.ct.gov` is a genuine ct.gov subdomain; the four
    // town sites are DIFFERENT registrable domains that merely contain the
    // string "ct.gov".
    vendor(
      "v-deep1",
      "Connecticut D.E.E.P.",
      "http://www.portal.ct.gov/DEEP/Boating/Boating-and-Paddling"
    );
    vendor(
      "v-deep2",
      "CT DEEP - Boating Division",
      "https://portal.ct.gov/deep/boating/boating-and-paddling"
    );
    promoter("p-whartford", "Town of West Hartford", "https://www.westhartfordct.gov");
    promoter(
      "p-trumbull",
      "Town of Trumbull Parks & Recreation",
      "https://www.trumbull-ct.gov/625/Arts-Festival"
    );
    promoter(
      "p-southington",
      "Southington Apple Harvest Festival",
      "https://www.southingtonct.gov/AHF/"
    );
    promoter("p-berlin", "Town of Berlin, CT", "https://www.berlinct.gov");

    const r = await resolveSenderIdentity(db as never, { fromAddress: "jeremy.hall@ct.gov" });

    // ⚠️ The ticket credits ct.gov with "2 vendors, 4 promoters, 4 events".
    // The 2 vendors are real. The rest are substring artefacts —
    // `westhartfordct.gov` is not `ct.gov`, and telling an operator that a
    // DEEP official "is" the Town of Berlin is worse than telling them
    // nothing.
    expect(r.matches.map((m) => m.entityId).sort()).toEqual(["v-deep1", "v-deep2"]);
    expect(r.matches.every((m) => m.basis === "website-domain")).toBe(true);
  });

  it("recognises Paradise City Arts — 1 promoter and its events", async () => {
    promoter("p-pca", "Paradise City Arts Festivals", "https://paradisecityarts.com/");
    event(
      "e-pca1",
      "Paradise City Arts Festival — Northampton",
      "https://paradisecityarts.com/northampton"
    );
    event(
      "e-pca2",
      "Paradise City Arts Festival — Marlborough",
      "https://paradisecityarts.com/marlborough"
    );

    const r = await resolveSenderIdentity(db as never, {
      fromAddress: "ewelford@paradisecityarts.com",
    });

    expect(r.matchedTypes.sort()).toEqual(["event", "promoter"]);
    expect(r.matches).toHaveLength(3);
  });

  it("recognises the three single-vendor senders", async () => {
    vendor("v-lerner", "David Lerner Associates", "https://www.davidlerner.com/");
    vendor("v-aehko", "aéhkō", "https://aehko.com");
    vendor("v-tpu", "TIMEPROOFUSA", "https://timeproofusa.com/");

    for (const [addr, id] of [
      ["carol.pace@davidlerner.com", "v-lerner"],
      ["contact@aehko.com", "v-aehko"],
      ["events@timeproofusa.com", "v-tpu"],
    ] as const) {
      const r = await resolveSenderIdentity(db as never, { fromAddress: addr });
      expect(r.best?.entityId, addr).toBe(id);
    }
  });

  it("resolves Freedom Boat Club via the brand key, where the domain join misses", async () => {
    // The deliberate hard case from the acceptance criteria: the vendor's
    // stored website is NOT freedomboatclub.us, so key (b) cannot fire. The
    // domain label normalises to the same brand key as the name, so key (c)
    // does.
    vendor("v-fbc", "Freedom Boat Club", "https://www.freedomboatclub.com/locations/maine");

    const r = await resolveSenderIdentity(db as never, {
      fromAddress: "celina.daigle@freedomboatclub.us",
    });

    expect(r.best?.entityId).toBe("v-fbc");
    expect(r.best?.basis).toBe("brand-name");
  });

  it("returns `none` for a stranger rather than erroring or guessing", async () => {
    vendor("v-other", "Somebody Else Entirely", "https://elsewhere.example");
    const r = await resolveSenderIdentity(db as never, {
      fromAddress: "nobody@totally-unrelated-domain.example",
    });
    expect(r.matches).toEqual([]);
    expect(r.best).toBeNull();
  });
});

describe("OPE-764 — precision, because a false match is worse than none", () => {
  it("does not match a domain that merely contains ours as a suffix-less substring", async () => {
    promoter("p-fake", "Not Us", "https://connect.government-example.com");
    const r = await resolveSenderIdentity(db as never, { fromAddress: "x@ct.gov" });
    expect(r.matches).toEqual([]);
  });

  it("does not match ct.gov against a ct.gov-prefixed impostor domain", async () => {
    // `https://ct.gov.evil.example` contains "//ct.gov" but is not ct.gov.
    promoter("p-evil", "Impostor", "https://ct.gov.evil.example/path");
    const r = await resolveSenderIdentity(db as never, { fromAddress: "x@ct.gov" });
    expect(r.matches).toEqual([]);
  });

  it("keeps the STRONGER basis when two keys find the same entity", async () => {
    // Both the contact email and the website point at one vendor. Reporting it
    // twice would make "N matches" mean different things depending on how many
    // keys happened to fire.
    vendor("v-both", "Double Match Co", "https://doublematch.example/", "hi@doublematch.example");
    const r = await resolveSenderIdentity(db as never, { fromAddress: "hi@doublematch.example" });
    expect(r.matches).toHaveLength(1);
    expect(r.best?.basis).toBe("contact-email");
    expect(r.best?.confidence).toBe(1);
  });

  it("matches a contact email case-insensitively on both sides", async () => {
    // `users.email` uniqueness is case-sensitive in this schema, so a
    // case-sensitive compare here misses rows that genuinely exist.
    vendor("v-case", "Mixed Case Co", null, "Owner@MixedCase.example");
    const r = await resolveSenderIdentity(db as never, { fromAddress: "owner@mixedcase.example" });
    expect(r.best?.entityId).toBe("v-case");
  });

  it("orders matches by confidence, strongest first", async () => {
    vendor("v-email", "Alpha Co", null, "person@shared.example");
    promoter("p-web", "Beta Org", "https://shared.example/");
    const r = await resolveSenderIdentity(db as never, { fromAddress: "person@shared.example" });
    expect(r.matches.map((m) => m.basis)).toEqual(["contact-email", "website-domain"]);
    expect(r.best?.entityId).toBe("v-email");
  });
});
