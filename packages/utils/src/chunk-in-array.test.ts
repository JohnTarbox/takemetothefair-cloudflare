/**
 * OPE-241 — chunkIds/chunkedInArray are the sanctioned remedy for D1's
 * 100-bound-parameter cap, so their edges matter: an off-by-one that lets a
 * 101-item batch through reintroduces the exact prod 500 they exist to prevent.
 */
import { describe, it, expect } from "vitest";
import {
  chunkIds,
  chunkedInArray,
  D1_SAFE_IN_CHUNK,
  D1_MAX_BIND_PARAMS,
  rowsPerInsert,
  runChunkedInsert,
} from "./chunk-in-array";

describe("chunkIds (OPE-241)", () => {
  it("returns no batches for an empty list, so callers never issue `IN ()`", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("keeps a list under the chunk size as a single batch", () => {
    expect(chunkIds([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("never emits a batch larger than the size — the whole point", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i);
    for (const batch of chunkIds(ids)) {
      expect(batch.length).toBeLessThanOrEqual(D1_SAFE_IN_CHUNK);
    }
  });

  it("defaults below D1's hard cap, leaving headroom for other bound params", () => {
    expect(D1_SAFE_IN_CHUNK).toBeLessThan(D1_MAX_BIND_PARAMS);
  });

  it("splits exactly at the boundary (90 → one batch, 91 → two)", () => {
    expect(chunkIds(Array.from({ length: 90 }, (_, i) => i))).toHaveLength(1);
    const two = chunkIds(Array.from({ length: 91 }, (_, i) => i));
    expect(two).toHaveLength(2);
    expect(two[0]).toHaveLength(90);
    expect(two[1]).toHaveLength(1);
  });

  it("covers every item exactly once, in order", () => {
    const ids = Array.from({ length: 205 }, (_, i) => i);
    expect(chunkIds(ids).flat()).toEqual(ids);
  });

  it("honours an explicit smaller size for queries that bind a lot elsewhere", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("rejects a nonsense size rather than looping forever", () => {
    // A size of 0 would make the `i += size` loop never advance.
    expect(() => chunkIds([1, 2], 0)).toThrow(RangeError);
  });
});

describe("chunkedInArray (OPE-241)", () => {
  it("fans out per batch and flattens, preserving order", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => i);
    const seen: number[][] = [];
    const rows = await chunkedInArray(ids, async (batch) => {
      seen.push(batch);
      return batch.map((n) => ({ id: n }));
    });
    expect(seen).toHaveLength(3);
    expect(seen.every((b) => b.length <= D1_SAFE_IN_CHUNK)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it("never calls the fetcher for an empty list", async () => {
    let calls = 0;
    const rows = await chunkedInArray([], async (b) => {
      calls++;
      return b;
    });
    expect(calls).toBe(0);
    expect(rows).toEqual([]);
  });

  it("runs batches sequentially, not in parallel (Workers subrequest budget)", async () => {
    const ids = Array.from({ length: 181 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await chunkedInArray(ids, async (batch) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return batch;
    });
    expect(maxInFlight).toBe(1);
  });

  it("propagates a batch failure rather than silently returning partial rows", async () => {
    await expect(
      chunkedInArray(
        Array.from({ length: 100 }, (_, i) => i),
        async (batch) => {
          if (batch.includes(90)) throw new Error("D1 down");
          return batch;
        }
      )
    ).rejects.toThrow("D1 down");
  });
});

describe("rowsPerInsert (OPE-1185)", () => {
  it("5 params per row → 20 rows (the bing_backlinks case: 30 rows was 150 params)", () => {
    expect(rowsPerInsert(5)).toBe(20);
    expect(rowsPerInsert(5) * 5).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
  });
  it("reserves fixed params, and never returns 0", () => {
    expect(rowsPerInsert(9, 10)).toBe(10);
    expect(rowsPerInsert(500)).toBe(1);
    expect(rowsPerInsert(0)).toBe(1);
  });
});

describe("runChunkedInsert (OPE-1185)", () => {
  // A fake statement that binds `per` params per row, so the helper's
  // measurement and chunking can be checked without a database.
  const fake = (per: number, executed: number[][]) => (chunk: number[]) => {
    const stmt = {
      toSQL: () => ({ params: new Array(chunk.length * per).fill(0) }),
      then<T1 = unknown, T2 = never>(
        ok?: ((v: unknown) => T1 | PromiseLike<T1>) | null,
        bad?: ((e: unknown) => T2 | PromiseLike<T2>) | null
      ): PromiseLike<T1 | T2> {
        executed.push(chunk);
        return Promise.resolve(undefined).then(ok, bad);
      },
    };
    return stmt;
  };

  it("measures params/row and keeps every executed statement ≤ 100 params", async () => {
    const executed: number[][] = [];
    const rows = Array.from({ length: 60 }, (_, i) => i);
    const n = await runChunkedInsert(rows, fake(5, executed));
    expect(n).toBe(3);
    expect(executed.map((c) => c.length)).toEqual([20, 20, 20]);
    expect(executed.flat()).toEqual(rows); // every row, in order, once
  });

  it("measuring does not execute: only the real chunks run", async () => {
    const executed: number[][] = [];
    await runChunkedInsert([1, 2, 3], fake(14, executed));
    expect(executed).toEqual([[1, 2, 3]]);
  });

  it("an empty list runs nothing", async () => {
    const executed: number[][] = [];
    expect(await runChunkedInsert([], fake(5, executed))).toBe(0);
    expect(executed).toEqual([]);
  });
});
