/**
 * OPE-1180 — the main app's FORMER-venue guard: explicit callers get the
 * verdict; ingest callers never fail (post-closure → no venue + review flag).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { parseEdtfBounds } from "@takemetothefair/utils";
import { checkEventVenue, resolveIngestVenue } from "../former-venue-guard";

let db: ReturnType<typeof drizzle<typeof schema>>;
const b = parseEdtfBounds("1881~")!;
const at = (d: string) => new Date(`${d}T12:00:00Z`);

beforeEach(() => {
  const raw = new Database(":memory:");
  raw["exec"](`CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
    use_ended_edtf TEXT, use_ended_earliest INTEGER, use_ended_latest INTEGER
  );`);
  raw
    .prepare(`INSERT INTO venues VALUES ('v-old','Montpelier Trotting Park','FORMER','1881~',?,?)`)
    .run(Math.floor(b.earliest.getTime() / 1000), Math.floor(b.latest.getTime() / 1000));
  raw.prepare(`INSERT INTO venues (id,name) VALUES ('v-live','Barre Auditorium')`).run();
  db = drizzle(raw, { schema });
});

describe("checkEventVenue", () => {
  it("refuses a post-closure event, naming the closure", async () => {
    const v = await checkEventVenue(db as never, "v-old", at("2026-09-27"));
    expect(v.kind).toBe("refuse");
    expect(v.kind === "refuse" && v.message).toContain("1881~");
  });
  it("flags inside the window, allows before it", async () => {
    expect((await checkEventVenue(db as never, "v-old", at("1881-06-01"))).kind).toBe("flag");
    expect((await checkEventVenue(db as never, "v-old", at("1879-06-01"))).kind).toBe("allow");
  });
  it("never judges an ACTIVE venue or no venue", async () => {
    expect((await checkEventVenue(db as never, "v-live", at("2026-09-27"))).kind).toBe("allow");
    expect((await checkEventVenue(db as never, null, at("2026-09-27"))).kind).toBe("allow");
  });
});

describe("resolveIngestVenue — an ingest never fails", () => {
  it("post-closure: drops the venue and flags", async () => {
    expect(await resolveIngestVenue(db as never, "v-old", at("2026-09-27"))).toMatchObject({
      venueId: null,
      flagForReview: true,
    });
  });
  it("inside the window: keeps the venue and flags", async () => {
    expect(await resolveIngestVenue(db as never, "v-old", at("1881-06-01"))).toMatchObject({
      venueId: "v-old",
      flagForReview: true,
    });
  });
  it("active venue: untouched, unflagged", async () => {
    expect(await resolveIngestVenue(db as never, "v-live", at("2026-09-27"))).toEqual({
      venueId: "v-live",
      flagForReview: false,
      note: null,
    });
  });
});
