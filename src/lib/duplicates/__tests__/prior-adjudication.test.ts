/**
 * OPE-450 — a decision a human already made must not be re-asked.
 *
 * A shell event lifted from a newsletter footer was rejected by hand on
 * 2026-07-28 and created again, verbatim, on 2026-08-17. `possible_duplicate_of`
 * was stamped both times, the dup reply went out both times, and the slug
 * collided into `-2`. Three layers saw it; none consulted the prior ruling.
 *
 * The tests below pin the two properties that make this safe to act on, and the
 * second matters more than the first:
 *
 *   1. it FIRES on the reported shape, and
 *   2. it stays SILENT on a bare rejection.
 *
 * Events are rejected for many reasons — spam, past-dated, wrong region.
 * Treating every rejection as "never accept this name+date again" would
 * silently suppress legitimate resubmissions, which is a worse failure than the
 * duplicate it prevents, because nobody would ever see it happen.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { findPriorAdjudication } from "../prior-adjudication";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT,
    start_date INTEGER, status TEXT,
    possible_duplicate_of TEXT, merged_into TEXT, rejected_as_duplicate_of TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const KEEPER = "defe4089-6065-4d29-bfae-dbd1285c099e";
const SHELL_NAME = "New England Made Autumn Show 2026";
const SHELL_DATE = "2026-09-15";

function seed(
  id: string,
  name: string,
  startIso: string,
  status: string,
  cols: { possible?: string; merged?: string; rejectedAs?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, slug, name, start_date, status,
         possible_duplicate_of, merged_into, rejected_as_duplicate_of)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      id,
      name,
      Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000),
      status,
      cols.possible ?? null,
      cols.merged ?? null,
      cols.rejectedAs ?? null
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the reported shape", () => {
  it("finds the 07-28 ruling when the 08-17 submission arrives", () => {
    seed("shell1", SHELL_NAME, SHELL_DATE, "REJECTED", { rejectedAs: KEEPER });
    return findPriorAdjudication(db, { name: SHELL_NAME, startDate: SHELL_DATE }).then((hit) => {
      expect(hit).not.toBeNull();
      expect(hit!.rejectedEventId).toBe("shell1");
      expect(hit!.keeperEventId).toBe(KEEPER);
      expect(hit!.basis).toBe("rejected_as_duplicate_of");
    });
  });

  it("also honours a merged-away row as a ruling", async () => {
    // Merging is the same decision reached another way.
    seed("shell1", SHELL_NAME, SHELL_DATE, "REJECTED", { merged: KEEPER });
    const hit = await findPriorAdjudication(db, { name: SHELL_NAME, startDate: SHELL_DATE });
    expect(hit?.basis).toBe("merged_into");
    expect(hit?.keeperEventId).toBe(KEEPER);
  });

  it("matches through name normalization", async () => {
    // The extractor's output varies run to run — ordinals, trailing year,
    // punctuation. normalizeName() is what makes the two submissions the same
    // candidate at all.
    seed("shell1", "38th New England Made Autumn Show 2026", SHELL_DATE, "REJECTED", {
      rejectedAs: KEEPER,
    });
    const hit = await findPriorAdjudication(db, {
      name: "New England Made Autumn Show",
      startDate: SHELL_DATE,
    });
    expect(hit?.rejectedEventId).toBe("shell1");
  });
});

describe("what must NOT be treated as an adjudication", () => {
  it("a bare REJECTED row is not a duplicate ruling", async () => {
    // Rejected as spam, past-dated, out of region… Suppressing a future
    // submission on this would be an invisible failure.
    seed("spam", SHELL_NAME, SHELL_DATE, "REJECTED");
    expect(await findPriorAdjudication(db, { name: SHELL_NAME, startDate: SHELL_DATE })).toBeNull();
  });

  it("possible_duplicate_of alone is a matcher's guess, not a decision", async () => {
    // The distinction this whole ticket turns on: a matcher suspected it,
    // nobody agreed. Acting on a suspicion would make the system suppress
    // submissions on its own say-so.
    seed("guessed", SHELL_NAME, SHELL_DATE, "REJECTED", { possible: KEEPER });
    expect(await findPriorAdjudication(db, { name: SHELL_NAME, startDate: SHELL_DATE })).toBeNull();
  });

  it("an APPROVED row carrying a ruling field is not a rejection", async () => {
    seed("live", SHELL_NAME, SHELL_DATE, "APPROVED", { rejectedAs: KEEPER });
    expect(await findPriorAdjudication(db, { name: SHELL_NAME, startDate: SHELL_DATE })).toBeNull();
  });
});

describe("the date key is exact, not a window", () => {
  it("does not match a different edition a few days apart", async () => {
    // ±7d is right for "same event?" because sources disagree on dates. It is
    // WRONG here: the question is "the same candidate a human already saw?",
    // and a window would let one rejection suppress a real nearby edition.
    seed("shell1", SHELL_NAME, "2026-09-15", "REJECTED", { rejectedAs: KEEPER });
    expect(
      await findPriorAdjudication(db, { name: SHELL_NAME, startDate: "2026-09-19" })
    ).toBeNull();
  });

  it("matches the same day regardless of time-of-day", async () => {
    seed("shell1", SHELL_NAME, "2026-09-15", "REJECTED", { rejectedAs: KEEPER });
    const hit = await findPriorAdjudication(db, {
      name: SHELL_NAME,
      startDate: "2026-09-15T18:30:00Z",
    });
    expect(hit?.rejectedEventId).toBe("shell1");
  });

  it("does not match a different name on the same date", async () => {
    seed("other", "Boxborough Antiques Fair 2026", SHELL_DATE, "REJECTED", { rejectedAs: KEEPER });
    expect(await findPriorAdjudication(db, { name: SHELL_NAME, startDate: SHELL_DATE })).toBeNull();
  });
});

describe("degenerate input returns null rather than matching broadly", () => {
  it.each([
    ["no name", { name: null, startDate: SHELL_DATE }],
    ["no date", { name: SHELL_NAME, startDate: null }],
    ["unparseable date", { name: SHELL_NAME, startDate: "not-a-date" }],
    ["name that normalizes to empty", { name: "!!!", startDate: SHELL_DATE }],
  ])("%s", async (_label, input) => {
    seed("shell1", SHELL_NAME, SHELL_DATE, "REJECTED", { rejectedAs: KEEPER });
    expect(await findPriorAdjudication(db, input)).toBeNull();
  });
});
