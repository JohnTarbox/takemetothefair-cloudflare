/**
 * OPE-1658 — third-party directory pages never become the "Official Event
 * Website" fallback. Applies the real migration to the live table shape and
 * drives the page's own path: gateUrlForField(…, "ticket") → pickEventCta.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateUrlForField,
  shouldIngestFromSource,
  type ClassificationMap,
} from "../url-classification";
import { pickEventCta } from "../events/event-cta";

const MIGRATION = readFileSync(
  join(import.meta.dirname, "../../../drizzle/0424_ope1658_directory_domains.sql"),
  "utf8"
);

// The live DDL (sqlite_master, 2026-11-17): every flag defaults to 0.
const DDL = `CREATE TABLE url_domain_classifications (
  id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, domain_type TEXT NOT NULL,
  use_as_ticket_url INTEGER NOT NULL DEFAULT 0, use_as_application_url INTEGER NOT NULL DEFAULT 0,
  use_as_source INTEGER NOT NULL DEFAULT 0, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT)`;

function apply(seed?: (db: InstanceType<typeof Database>) => void): ClassificationMap {
  const db = new Database(":memory:");
  db.exec(DDL);
  seed?.(db);
  db.exec(MIGRATION);
  const rows = db
    .prepare(
      "SELECT domain, use_as_ticket_url t, use_as_application_url a, use_as_source s FROM url_domain_classifications"
    )
    .all() as { domain: string; t: number; a: number; s: number }[];
  return new Map(
    rows.map((r) => [
      r.domain,
      { useAsTicketUrl: !!r.t, useAsApplicationUrl: !!r.a, useAsSource: !!r.s },
    ])
  );
}

const cta = (sourceUrl: string, map: ClassificationMap) =>
  pickEventCta({
    ticketUrl: null,
    vettedSourceUrl: gateUrlForField(sourceUrl, "ticket", map),
    ticketPriceMaxCents: null,
  });

describe("0424 — directory domains", () => {
  it("an event whose only source is a directory page gets NO fallback button", () => {
    const map = apply();
    // Landmark: the migration really inserted the two rows it names.
    expect([...map.keys()].sort()).toEqual(["happeningnext.com", "mafa.org"]);
    expect(cta("https://www.mafa.org/2026fairsbydate.html", map)).toBeNull();
    expect(cta("https://happeningnext.com/waterville/christmas-markets-and-fairs", map)).toBeNull();
  });

  it("still allows ingesting FROM them (use_as_source = 1, not the column's default 0)", () => {
    const map = apply();
    expect(shouldIngestFromSource("https://www.mafa.org/2026fairsbydate.html", map)).toBe(true);
    expect(shouldIngestFromSource("https://happeningnext.com/x", map)).toBe(true);
  });

  it("leaves organizers' own multi-show pages linking (the ticket's do-not-exclude list)", () => {
    const map = apply();
    for (const url of [
      "https://www.newenglandcraftfairs.com/maine-craft-fairs.html",
      "https://societyofsouthernmainecraftsmen.org/shows.html",
      "https://gnecraftartisanshows.com/calendar",
      "https://festivals.paradisecityarts.com/shows",
    ]) {
      expect(cta(url, map)).toMatchObject({ url, ctaSource: "source_url" });
    }
  });

  it("does not overwrite a row a person already classified", () => {
    const map = apply((db) =>
      db.exec(
        `INSERT INTO url_domain_classifications (id, domain, domain_type, use_as_ticket_url, use_as_application_url, use_as_source, created_at, updated_at)
         VALUES ('x', 'mafa.org', 'promoter', 1, 1, 1, 0, 0)`
      )
    );
    expect(map.get("mafa.org")).toEqual({
      useAsTicketUrl: true,
      useAsApplicationUrl: true,
      useAsSource: true,
    });
  });
});
