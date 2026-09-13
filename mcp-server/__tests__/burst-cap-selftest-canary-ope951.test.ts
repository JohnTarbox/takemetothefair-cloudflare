/**
 * OPE-951 — the daily canary fires the main app's self-test through the
 * service binding, logs anything but a 2xx, and never throws.
 */
import { describe, expect, it, vi } from "vitest";

const logError = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));

import { runScheduledBurstCapSelfTest } from "../src/burst-cap-selftest-canary.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function envWith(fetchImpl: (r: Request) => Promise<Response>) {
  const seen: Request[] = [];
  return {
    seen,
    env: {
      DB: {},
      INTERNAL_API_KEY: "k",
      MAIN_APP: {
        fetch: async (r: Request) => {
          seen.push(r);
          return fetchImpl(r);
        },
      },
    } as never,
  };
}

describe("runScheduledBurstCapSelfTest", () => {
  it("POSTs the self-test route with the internal key and scheduled entrypoint", async () => {
    const { env, seen } = envWith(async () => new Response('{"ok":true}', { status: 200 }));
    await runScheduledBurstCapSelfTest(env);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe("/api/internal/burst-selftest");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get("X-Internal-Key")).toBe("k");
    expect(seen[0].headers.get("X-MMATF-Entrypoint")).toBe("scheduled");
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs a FAILED self-test (500) instead of swallowing it", async () => {
    logError.mockClear();
    const { env } = envWith(async () => new Response('{"ok":false}', { status: 500 }));
    await runScheduledBurstCapSelfTest(env);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when the call itself throws", async () => {
    logError.mockClear();
    const { env } = envWith(async () => {
      throw new Error("down");
    });
    // mainAppFetch falls back to the public URL on a binding throw; stub it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("also down");
    }) as typeof fetch;
    try {
      await expect(runScheduledBurstCapSelfTest(env)).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("is registered in the daily cron branch", () => {
    // Anchor on the CALL, not the bare name, which also matches the import.
    const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
    expect(src).toMatch(/^\s+runScheduledBurstCapSelfTest\(env\),$/m);
  });
});
