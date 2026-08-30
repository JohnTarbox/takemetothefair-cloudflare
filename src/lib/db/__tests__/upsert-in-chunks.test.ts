/**
 * OPE-641 — the memory-ceiling assertion OPE-489 asked for (item 5) and never got.
 *
 * This family has now escaped twice, so the deliverable is the assertion, not
 * the refactor. What it pins is the property that actually failed: how many
 * statement objects EXIST at once — not how many execute together, which is
 * what the deleted `runBatched` bounded while the OOM continued.
 *
 * Sized at the real projected dataset, measured on prod 2026-08-30:
 * `gsc_search_metrics` takes 3,000-5,000 rows/day and the incremental window is
 * `[today-7, today-3]`, so 25,000 is an ordinary day, not a pathological one.
 */
import { describe, it, expect } from "vitest";
import { upsertInChunks } from "../upsert-in-chunks";

/** A db stand-in that records how many statements were alive at each flush. */
function recordingDb() {
  const peaks: number[] = [];
  let built = 0;
  return {
    peaks,
    note: () => built++,
    reset: () => (built = 0),
    db: {
      batch: async () => {
        peaks.push(built);
        built = 0;
      },
    },
    get maxAlive() {
      return Math.max(0, ...peaks);
    },
  };
}

describe("bounds live statements at projected dataset size (OPE-641)", () => {
  it("never holds more than one chunk of statements, at 25,000 rows", async () => {
    const rows = Array.from({ length: 25_000 }, (_, i) => ({ i }));
    const r = recordingDb();

    const executed = await upsertInChunks(
      r.db as never,
      rows,
      (row) => {
        r.note();
        return row;
      },
      50
    );

    expect(executed).toBe(25_000);
    // The assertion that fails against `rows.map(...)` then a chunked execute:
    // that shape builds all 25,000 before the first batch, so maxAlive = 25000.
    expect(r.maxAlive).toBeLessThanOrEqual(50);
    expect(r.peaks).toHaveLength(500); // 25,000 / 50
  });

  it("respects a custom chunk size", async () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => ({ i }));
    const r = recordingDb();
    await upsertInChunks(
      r.db as never,
      rows,
      (row) => {
        r.note();
        return row;
      },
      10
    );
    expect(r.maxAlive).toBeLessThanOrEqual(10);
  });

  it("builds NOTHING and issues no batch for an empty result set", async () => {
    // A feed returning zero rows must not emit an empty batch — D1 rejects one.
    const r = recordingDb();
    const executed = await upsertInChunks(r.db as never, [], () => ({}), 50);
    expect(executed).toBe(0);
    expect(r.peaks).toHaveLength(0);
  });

  it("maps every row exactly once, in order", async () => {
    const rows = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    await upsertInChunks(
      { batch: async () => {} } as never,
      rows,
      (n) => {
        seen.push(n);
        return n;
      },
      2
    );
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});
