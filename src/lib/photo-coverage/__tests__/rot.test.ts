/**
 * OPE-225 PR 2/2 — URL rot detection.
 *
 * Two things carry real risk here:
 *  1. **False positives.** Marking a live image dead pushes a healthy entity
 *     into the sourcing queue and erodes trust in the whole flag — worse than
 *     missing a dead one. Hence the HEAD→GET fallback, tested explicitly.
 *  2. **The verdict surviving the daily scan.** `UNREACHABLE` is measured;
 *     everything else is derived from the URL string. If the coverage scan
 *     re-derived health every night, a rot verdict would live less than a day.
 *     That interaction is tested in model.test.ts (rule 4).
 */
import { describe, it, expect, vi } from "vitest";
import { probeImageUrl, sweepImageUrlHealth } from "../rot";

const res = (status: number) => new Response(null, { status });

describe("probeImageUrl", () => {
  it("accepts a HEAD 200 without a second request", async () => {
    const f = vi.fn(async () => res(200));
    expect(await probeImageUrl("https://x.test/a.jpg", f as unknown as typeof fetch)).toEqual({
      ok: true,
      status: 200,
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("marks a 404 unreachable", async () => {
    const f = vi.fn(async () => res(404));
    const out = await probeImageUrl("https://x.test/a.jpg", f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1); // 404 is a real answer, no retry
  });

  it("retries as GET when the host refuses HEAD — a live image must not be condemned", async () => {
    // WordPress hosts and some CDNs answer 403/405 to HEAD but serve GET fine.
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === "HEAD" ? res(405) : res(206)
    );
    const out = await probeImageUrl("https://wp.test/a.jpg", f as unknown as typeof fetch);
    expect(out.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[1][1] as RequestInit).method).toBe("GET");
  });

  it("does not retry a 500 — that is a real answer, not a method problem", async () => {
    const f = vi.fn(async () => res(500));
    await probeImageUrl("https://x.test/a.jpg", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown fetch (DNS/TLS/timeout) as unreachable with a NULL status", async () => {
    const f = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await probeImageUrl("https://gone.test/a.jpg", f as unknown as typeof fetch)).toEqual({
      ok: false,
      status: null,
    });
  });
});

/** Minimal drizzle stand-in: records the updates the sweep issues. */
function fakeDb(rows: Array<Record<string, unknown>>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => rows }),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push(vals);
        },
      }),
    }),
  };
  return { db: db as never, updates };
}

const row = (over: Record<string, unknown> = {}) => ({
  entityType: "EVENT",
  entityId: "e1",
  imageUrl: "https://cdn.meetmeatthefair.com/e/a.webp",
  urlHealth: "OWNED",
  ...over,
});

describe("sweepImageUrlHealth", () => {
  it("records UNREACHABLE with the status for a dead URL", async () => {
    const { db, updates } = fakeDb([row({ imageUrl: "https://fair.test/gone.jpg" })]);
    const out = await sweepImageUrlHealth(db, {
      fetchImpl: (async () => res(404)) as unknown as typeof fetch,
    });

    expect(out).toMatchObject({ checked: 1, unreachable: 1, reachable: 0 });
    expect(updates[0]).toMatchObject({ urlHealth: "UNREACHABLE", urlStatusCode: 404 });
    expect(updates[0].urlCheckedAt).toBeInstanceOf(Date);
  });

  it("restores a recovered URL to its DERIVED health, not a blanket OK", async () => {
    // A previously-dead hotlink that answers again is HOTLINKED, not OWNED —
    // recovery must not launder a third-party URL into looking like ours.
    const { db, updates } = fakeDb([
      row({ imageUrl: "https://fair.test/back.jpg", urlHealth: "UNREACHABLE" }),
    ]);
    const out = await sweepImageUrlHealth(db, {
      fetchImpl: (async () => res(200)) as unknown as typeof fetch,
    });

    expect(out).toMatchObject({ reachable: 1, recovered: 1 });
    expect(updates[0]).toMatchObject({ urlHealth: "HOTLINKED", urlStatusCode: 200 });
  });

  it("stamps url_checked_at even when the URL is fine, so the round-robin advances", async () => {
    const { db, updates } = fakeDb([row()]);
    await sweepImageUrlHealth(db, {
      now: new Date("2026-07-21T00:00:00Z"),
      fetchImpl: (async () => res(200)) as unknown as typeof fetch,
    });
    // Without this the same URLs would be re-checked forever and the rest
    // would never be reached.
    expect(updates[0].urlCheckedAt).toEqual(new Date("2026-07-21T00:00:00Z"));
  });

  it("skips rows whose image_url is blank rather than fetching ''", async () => {
    const { db, updates } = fakeDb([row({ imageUrl: "   " })]);
    const f = vi.fn(async () => res(200));
    const out = await sweepImageUrlHealth(db, { fetchImpl: f as unknown as typeof fetch });

    expect(f).not.toHaveBeenCalled();
    expect(out.checked).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("one dead host does not abort the sweep of the others", async () => {
    const { db, updates } = fakeDb([
      row({ entityId: "a", imageUrl: "https://dead.test/1.jpg" }),
      row({ entityId: "b", imageUrl: "https://cdn.meetmeatthefair.com/2.webp" }),
    ]);
    const out = await sweepImageUrlHealth(db, {
      fetchImpl: (async (u: string) => {
        if (String(u).includes("dead.test")) throw new Error("ENOTFOUND");
        return res(200);
      }) as unknown as typeof fetch,
    });

    expect(out).toMatchObject({ checked: 2, unreachable: 1, reachable: 1 });
    expect(updates).toHaveLength(2);
  });
});
