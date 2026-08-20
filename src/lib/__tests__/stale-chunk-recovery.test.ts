import { describe, expect, it } from "vitest";
import {
  CHUNK_RELOAD_SENTINEL,
  RELOAD_COOLDOWN_MS,
  claimReloadAttempt,
  isStaleChunkError,
  recoverFromStaleChunk,
  type SentinelStorage,
} from "@/lib/stale-chunk-recovery";

/** In-memory sessionStorage stand-in. */
function memStorage(
  seed: Record<string, string> = {}
): SentinelStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const WEBPACK_STACK = "TypeError\n    at webpack-317a5b9c90d0ab32.js:1:2930";

describe("isStaleChunkError", () => {
  it.each([
    "ChunkLoadError: Loading chunk 7466 failed.",
    "Loading chunk 8039 failed.\n(timeout: https://meetmeatthefair.com/_next/static/chunks/8039.js)",
    "Failed to fetch dynamically imported module: https://meetmeatthefair.com/_next/static/chunks/2463.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
  ])("matches the stale-chunk message %#", (message) => {
    expect(isStaleChunkError({ message })).toBe(true);
  });

  it("matches the module-factory shape ONLY with a webpack runtime frame", () => {
    const message = "Cannot read properties of undefined (reading 'call')";
    // The real OPE-485 specimen: thrown from the webpack module factory.
    expect(isStaleChunkError({ message, stack: WEBPACK_STACK })).toBe(true);
    // The same message from ordinary app code is an ordinary bug. Reloading on
    // it would cost a user their form state to fix nothing.
    expect(
      isStaleChunkError({ message, stack: "at EventCard (src/components/EventCard.tsx:42:9)" })
    ).toBe(false);
    expect(isStaleChunkError({ message })).toBe(false);
  });

  it("matches the Safari wording of the module-factory shape", () => {
    expect(
      isStaleChunkError({
        message: "undefined is not an object (evaluating 'o.call')",
        stack: WEBPACK_STACK,
      })
    ).toBe(true);
  });

  it.each([
    "TypeError: Cannot read properties of null (reading 'parentNode')",
    "NetworkError when attempting to fetch resource.",
    "Unexpected token '<'",
    "",
  ])("does not match unrelated error %#", (message) => {
    expect(isStaleChunkError({ message, stack: WEBPACK_STACK })).toBe(false);
  });
});

describe("claimReloadAttempt — the loop guard", () => {
  it("allows the first attempt and records it", () => {
    const s = memStorage();
    expect(claimReloadAttempt(s, 1_000_000)).toBe(true);
    expect(s.data[CHUNK_RELOAD_SENTINEL]).toBe("1000000");
  });

  it("REFUSES a second attempt inside the cooldown — this is the anti-loop property", () => {
    const s = memStorage();
    const t0 = 1_000_000;
    expect(claimReloadAttempt(s, t0)).toBe(true);
    // A reload loop's attempts are milliseconds apart.
    expect(claimReloadAttempt(s, t0 + 50)).toBe(false);
    expect(claimReloadAttempt(s, t0 + RELOAD_COOLDOWN_MS - 1)).toBe(false);
  });

  it("allows a LATER genuine incident once the cooldown passes", () => {
    // A tab commonly outlives several deploys; a permanent flag would spend the
    // tab's only recovery on the first one and leave it broken for the rest.
    const s = memStorage();
    const t0 = 1_000_000;
    expect(claimReloadAttempt(s, t0)).toBe(true);
    expect(claimReloadAttempt(s, t0 + RELOAD_COOLDOWN_MS)).toBe(true);
  });

  it("refuses when storage is unavailable or throws (no sentinel → no promise of bounded loops)", () => {
    expect(claimReloadAttempt(null, 1)).toBe(false);
    const hostile: SentinelStorage = {
      getItem: () => {
        throw new Error("SecurityError: storage disabled");
      },
      setItem: () => {},
    };
    expect(claimReloadAttempt(hostile, 1)).toBe(false);
  });

  it("tolerates a corrupted sentinel value rather than wedging", () => {
    const s = memStorage({ [CHUNK_RELOAD_SENTINEL]: "not-a-number" });
    expect(claimReloadAttempt(s, 1_000_000)).toBe(true);
  });
});

describe("recoverFromStaleChunk", () => {
  it("reloads exactly once for a stale chunk, never twice", () => {
    const s = memStorage();
    let reloads = 0;
    let now = 1_000_000;
    const deps = { storage: s, now: () => now, reload: () => void (reloads += 1) };
    const err = { message: "ChunkLoadError: Loading chunk 7466 failed." };

    expect(recoverFromStaleChunk(err, deps)).toBe(true);
    expect(reloads).toBe(1);

    // The reload landed on a still-broken build and the error fired again.
    now += 200;
    expect(recoverFromStaleChunk(err, deps)).toBe(false);
    expect(reloads).toBe(1);
  });

  it("does not reload — or even consume the sentinel — for an unrelated error", () => {
    const s = memStorage();
    let reloads = 0;
    const ok = recoverFromStaleChunk(
      { message: "TypeError: x is not a function", stack: "at Foo (foo.tsx:1:1)" },
      { storage: s, now: () => 1_000_000, reload: () => void (reloads += 1) }
    );
    expect(ok).toBe(false);
    expect(reloads).toBe(0);
    // Not consuming the sentinel matters: an ordinary bug must not disarm the
    // recovery for a real stale-chunk error moments later.
    expect(s.data[CHUNK_RELOAD_SENTINEL]).toBeUndefined();
  });
});
