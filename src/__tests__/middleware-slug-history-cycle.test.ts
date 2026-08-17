/**
 * OPE-423 — is the event slug-history walker cycle-safe?
 *
 * The ticket flagged this as something to confirm BEFORE repairing the data,
 * and it was right to: the production rows now contain two history entries
 * that chain through the same slug, because a merged tombstone was resurrected
 * and renamed back on 2026-06-25.
 *
 *   old: bar-harbor-fall-craft-fair-2026            → arts-at-atlantic-oceanside-october
 *   old: bar-harbor-fall-craft-fair-2026-merged-9a395062 → bar-harbor-fall-craft-fair-2026
 *
 * Answer, established by reading src/middleware.ts: YES, it is safe. It carries
 * a `seen` Set, caps at 5 hops, and verifies the chain terminus is a live
 * public event before issuing the 301. Nothing needed changing.
 *
 * These tests mirror that loop rather than importing it — the walker is inline
 * in the middleware, interleaved with DB calls and NextResponse construction,
 * and extracting it purely to make it testable is a bigger change than this
 * ticket justifies. The mirror is therefore a SPEC, not a regression guard:
 * it records the three properties the real loop must keep. If the middleware
 * loop is ever refactored, port it to this shape and delete the mirror.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the walk in src/middleware.ts (the events branch). */
function walk(history: Record<string, string>, start: string, maxHops = 5): string {
  let cursor = start;
  const seen = new Set<string>([cursor]);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = history[cursor];
    if (!next || seen.has(next)) break;
    cursor = next;
    seen.add(cursor);
  }
  return cursor;
}

describe("cycle safety", () => {
  it("terminates on a direct A→B→A cycle instead of spinning", () => {
    // Exactly the state the ticket warned a naive repair would create:
    // A.merged_into = B, then merging B into A.
    const history = { a: "b", b: "a" };
    expect(walk(history, "a")).toBe("b");
  });

  it("terminates on a self-referential row", () => {
    expect(walk({ a: "a" }, "a")).toBe("a");
  });

  it("terminates on a longer cycle", () => {
    expect(walk({ a: "b", b: "c", c: "a" }, "a")).toBe("c");
  });
});

describe("the chain the production data actually contains", () => {
  const MERGED = "bar-harbor-fall-craft-fair-2026-merged-9a395062";
  const ORIGINAL = "bar-harbor-fall-craft-fair-2026";
  const KEEPER = "arts-at-atlantic-oceanside-october";
  const history = { [MERGED]: ORIGINAL, [ORIGINAL]: KEEPER };

  it("walks the resurrection chain through to the keeper", () => {
    expect(walk(history, MERGED)).toBe(KEEPER);
  });

  it("resolves the original slug straight to the keeper", () => {
    // Note this only matters while no LIVE event holds ORIGINAL. Today one
    // does (the resurrected tombstone), so the middleware serves it 200 and
    // never reaches the history walk at all — which is precisely the defect.
    expect(walk(history, ORIGINAL)).toBe(KEEPER);
  });
});

describe("hop cap", () => {
  it("stops after 5 hops on a long acyclic chain rather than walking forever", () => {
    const history = { a: "b", b: "c", c: "d", d: "e", e: "f", f: "g", g: "h" };
    // 5 hops from "a" lands on "f"; the walker gives up there rather than
    // issuing an unbounded number of queries on a pathological chain.
    expect(walk(history, "a")).toBe("f");
  });

  it("returns the start slug unchanged when there is no history at all", () => {
    // The middleware compares cursor !== slug to decide whether to 301, so
    // returning the input unchanged is what suppresses a pointless redirect.
    expect(walk({}, "a")).toBe("a");
  });
});
