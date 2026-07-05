import { describe, it, expect } from "vitest";
import {
  clientErrorDedupKey,
  isDuplicateClientError,
  type DedupKv,
} from "../client-error-ingest-dedup";

/** In-memory fake KV honoring expirationTtl against an injectable clock. */
function fakeKv(nowRef: { t: number }): DedupKv & { size: () => number } {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt <= nowRef.t) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    async put(key, value, options) {
      const ttl = options?.expirationTtl ?? 3600;
      store.set(key, { value, expiresAt: nowRef.t + ttl * 1000 });
    },
    size: () => store.size,
  };
}

describe("client-error-ingest-dedup (OPE-106)", () => {
  it("first sight is not a duplicate; an identical repeat within the window IS", async () => {
    const now = { t: 0 };
    const kv = fakeKv(now);
    const sig = "/events/[slug]#boom";
    expect(await isDuplicateClientError(kv, "1.2.3.4", sig, 60)).toBe(false);
    expect(await isDuplicateClientError(kv, "1.2.3.4", sig, 60)).toBe(true);
    expect(await isDuplicateClientError(kv, "1.2.3.4", sig, 60)).toBe(true);
  });

  it("collapses a burst of the same signature from one client to a single write", async () => {
    const now = { t: 0 };
    const kv = fakeKv(now);
    const sig = "/x#unhandledrejection object not found";
    let written = 0;
    // Simulate 58 rapid reports from one client (the prod burst shape).
    for (let i = 0; i < 58; i++) {
      if (!(await isDuplicateClientError(kv, "9.9.9.9", sig, 60))) written++;
    }
    expect(written).toBe(1);
  });

  it("different clients with the same signature each register (distinct-session signal preserved)", async () => {
    const now = { t: 0 };
    const kv = fakeKv(now);
    const sig = "/x#boom";
    expect(await isDuplicateClientError(kv, "1.1.1.1", sig, 60)).toBe(false);
    expect(await isDuplicateClientError(kv, "2.2.2.2", sig, 60)).toBe(false);
    expect(await isDuplicateClientError(kv, "3.3.3.3", sig, 60)).toBe(false);
  });

  it("the same signature is allowed again once the window elapses (not muted forever)", async () => {
    const now = { t: 0 };
    const kv = fakeKv(now);
    const sig = "/x#boom";
    expect(await isDuplicateClientError(kv, "1.2.3.4", sig, 60)).toBe(false);
    expect(await isDuplicateClientError(kv, "1.2.3.4", sig, 60)).toBe(true);
    now.t += 61_000; // window elapses
    expect(await isDuplicateClientError(kv, "1.2.3.4", sig, 60)).toBe(false);
  });

  it("fails open: a null binding never suppresses", async () => {
    expect(await isDuplicateClientError(null, "1.2.3.4", "/x#boom", 60)).toBe(false);
  });

  it("fails open: a KV that throws never suppresses", async () => {
    const throwingKv: DedupKv = {
      async get() {
        throw new Error("kv down");
      },
      async put() {
        throw new Error("kv down");
      },
    };
    expect(await isDuplicateClientError(throwingKv, "1.2.3.4", "/x#boom", 60)).toBe(false);
  });

  it("key is deterministic and distinguishes ip and signature", () => {
    expect(clientErrorDedupKey("1.2.3.4", "/x#boom")).toBe(
      clientErrorDedupKey("1.2.3.4", "/x#boom")
    );
    expect(clientErrorDedupKey("1.2.3.4", "/x#boom")).not.toBe(
      clientErrorDedupKey("5.6.7.8", "/x#boom")
    );
    expect(clientErrorDedupKey("1.2.3.4", "/x#boom")).not.toBe(
      clientErrorDedupKey("1.2.3.4", "/y#boom")
    );
    expect(clientErrorDedupKey("1.2.3.4", "/x#boom")).toMatch(/^cerr-dedup:[0-9a-f]+$/);
  });
});
