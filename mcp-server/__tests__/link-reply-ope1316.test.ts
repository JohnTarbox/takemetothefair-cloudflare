/**
 * OPE-1316 — a link that produced no event gets the reply that matches what
 * actually happened to it (John's 2026-11-03 ruling, texts A/B/C).
 *
 * Specimen: inbound `1e10e617` (2026-10-05), body `https://near-fest.com/`, the
 * official home page of NEAR-Fest XL, which we list with that exact source_url.
 * It got "couldn't read the event details … shorteners, redirects, JavaScript".
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  decideLinkReply,
  exactLinkVariants,
  findListedEventByExactLink,
  linkCauseSentence,
} from "../src/email-handlers/link-reply.js";
import { buildReply } from "../src/email-reply-builder.js";
import type { Db } from "../src/db.js";

let db: TestDb;
let raw: { exec: (s: string) => unknown };
const T = (d: string) => Math.floor(new Date(d).getTime() / 1000);
const NOW = new Date("2026-08-01T12:00:00Z");

function event(
  id: string,
  slug: string,
  sourceUrl: string,
  start: string,
  extra: { status?: string; mergedInto?: string; name?: string } = {}
) {
  raw.exec(
    `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, lifecycle_status, source_url, merged_into)
     VALUES ('${id}', '${extra.name ?? "NEAR-Fest XL"}', '${slug}', 'p1', ${T(start)}, ${T(start) + 86400},
             '${extra.status ?? "APPROVED"}', 'SCHEDULED', '${sourceUrl}', ${extra.mergedInto ? `'${extra.mergedInto}'` : "NULL"})`
  );
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as typeof raw;
  raw.exec(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'NEAR', 'near')`);
});

describe("exactLinkVariants — scheme, www. and trailing slash only", () => {
  it("covers all eight spellings of a bare home page", () => {
    const v = exactLinkVariants("https://near-fest.com/");
    expect(v).toContain("https://near-fest.com/");
    expect(v).toContain("http://www.near-fest.com");
    expect(v).toContain("https://www.near-fest.com/");
    expect(v).toHaveLength(8);
  });

  it("keeps the path and the query as sent — that is what makes it exact", () => {
    const v = exactLinkVariants("https://www.example.org/fair/2026?id=4");
    expect(v).toContain("https://example.org/fair/2026?id=4");
    expect(v.every((u) => u.includes("/fair/2026?id=4"))).toBe(true);
    // A different page on the same domain is NOT one of the variants (no domain matching).
    expect(v).not.toContain("https://example.org/");
  });

  it("refuses non-http input", () => {
    expect(exactLinkVariants("mailto:x@y.com")).toEqual([]);
    expect(exactLinkVariants("not a url")).toEqual([]);
    expect(exactLinkVariants(null)).toEqual([]);
  });
});

describe("findListedEventByExactLink", () => {
  it("1e10e617: near-fest.com/ resolves to the listed NEAR-Fest XL", async () => {
    event("ev-near", "near-fest-xl", "http://www.near-fest.com", "2026-10-02T12:00:00Z");
    const hit = await findListedEventByExactLink(
      db as unknown as Db,
      "https://near-fest.com/",
      NOW
    );
    expect(hit?.id).toBe("ev-near");
  });

  it("does not match a different page on the same domain", async () => {
    event("ev-near", "near-fest-xl", "https://near-fest.com/vendors", "2026-10-02T12:00:00Z");
    expect(
      await findListedEventByExactLink(db as unknown as Db, "https://near-fest.com/", NOW)
    ).toBeNull();
  });

  it("never points at a non-public row or a merge tombstone", async () => {
    event("ev-pend", "near-pending", "https://near-fest.com/", "2026-10-02T12:00:00Z", {
      status: "PENDING",
    });
    event("ev-keep", "near-keeper", "https://other.example/", "2026-10-02T12:00:00Z");
    event("ev-tomb", "near-merged-x", "https://near-fest.com/", "2026-10-02T12:00:00Z", {
      mergedInto: "ev-keep",
      status: "REJECTED",
    });
    expect(
      await findListedEventByExactLink(db as unknown as Db, "https://near-fest.com/", NOW)
    ).toBeNull();
  });

  it("prefers the next upcoming edition when a series shares one home page", async () => {
    event("ev-2025", "near-fest-2025", "https://near-fest.com/", "2025-10-03T12:00:00Z");
    event("ev-2026", "near-fest-2026", "https://near-fest.com/", "2026-10-02T12:00:00Z");
    event("ev-2027", "near-fest-2027", "https://near-fest.com/", "2027-10-01T12:00:00Z");
    const hit = await findListedEventByExactLink(db as unknown as Db, "https://near-fest.com", NOW);
    expect(hit?.id).toBe("ev-2026");
  });
});

describe("decideLinkReply + the approved copy", () => {
  const link = "https://near-fest.com/";
  const base = { subject: "Nearfest", attemptedUrl: link };

  it("match found → reply A naming our page, not the couldn't-read reply", () => {
    const d = decideLinkReply({
      link,
      linkOutcome: "fetch-failed",
      listed: {
        id: "ev-near",
        slug: "near-fest-xl",
        name: "NEAR-Fest XL",
        startDate: new Date("2026-10-02T12:00:00Z"),
        endDate: new Date("2026-10-03T12:00:00Z"),
      },
      params: base,
    });
    expect(d.kind).toBe("already-listed-link");
    expect(d.flagForReview).toBe(false);
    const msg = buildReply(d.kind, "john@example.com", d.params);
    expect(msg.text).toContain("That event is already listed with us:");
    expect(msg.text).toContain("NEAR-Fest XL — Oct 2, 2026 – Oct 3, 2026");
    expect(msg.text).toContain("https://meetmeatthefair.com/events/near-fest-xl");
    expect(msg.text).not.toContain("couldn't");
    expect(msg.text).not.toContain("If you didn't mean to email us");
    expect(msg.source).toBe("email:already-listed-link");
  });

  it("no match, fetch failed → reply C, cause sentence names no sender-side cause", () => {
    const d = decideLinkReply({ link, linkOutcome: "fetch-failed", listed: null, params: base });
    expect(d.kind).toBe("unfetchable-url");
    expect(d.flagForReview).toBe(false);
    const msg = buildReply(d.kind, "john@example.com", d.params);
    expect(msg.text).toContain(
      "We found a link in your message but couldn't open it. The site didn't let our reader in."
    );
    expect(msg.text).toContain("The link we tried was:\n  https://near-fest.com/");
    expect(msg.text).not.toMatch(/shortene|redirect|JavaScript/i);
    expect(msg.text).not.toContain("If you didn't mean to email us");
  });

  it("reply C names a shortener only when the link is one", () => {
    expect(linkCauseSentence("https://share.google/g2SzVzDbYq2WHPr2f")).toBe(
      "It looks like a shortened or redirect link, and those don't always open for us."
    );
    expect(linkCauseSentence("https://near-fest.com/")).toBe("The site didn't let our reader in.");
  });

  it("no match, page opened but no event → reply B, and the row must be flagged", () => {
    const d = decideLinkReply({
      link,
      linkOutcome: "fetched-no-event",
      listed: null,
      params: base,
    });
    expect(d.kind).toBe("unfetchable-url");
    expect(d.flagForReview).toBe(true);
    const msg = buildReply(d.kind, "john@example.com", d.params);
    expect(msg.text).toContain(
      "We opened the page you sent but couldn't pick out the event details from it automatically. A person on our side will take a look."
    );
    expect(msg.text).not.toContain("If you didn't mean to email us");
  });

  it("link never fetched (free-text override) → neither B nor C is claimed", () => {
    const d = decideLinkReply({ link, linkOutcome: undefined, listed: null, params: base });
    expect(d.kind).toBe("unfetchable-url");
    expect(d.flagForReview).toBe(false);
    const msg = buildReply(d.kind, "john@example.com", d.params);
    expect(msg.text).not.toContain("We opened the page");
    expect(msg.text).not.toContain("couldn't open it.");
  });

  it("OPE-771: reply A with no resolved event falls back to the couldn't-use-it reply", () => {
    const msg = buildReply("already-listed-link", "john@example.com", {
      ...base,
      assertionFacts: { listedEventId: null } as never,
    });
    expect(msg.source).toBe("email:unfetchable-url");
  });
});
