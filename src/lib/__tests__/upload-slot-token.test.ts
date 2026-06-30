import { describe, expect, it, beforeEach } from "vitest";

import {
  issueUploadSlot,
  consumeUploadSlot,
  peekUploadSlot,
  __testing,
} from "../upload-slot-token";

/**
 * In-memory fake of KVNamespace covering the subset of the API
 * upload-slot-token.ts depends on. The real KV's `expirationTtl` is
 * server-side; the fake records the TTL value so tests can assert it
 * but doesn't expire entries on a timer.
 */
class FakeKV {
  private store = new Map<string, { value: string; expirationTtl?: number }>();

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  async get(key: string, _type: "text"): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test introspection helpers — NOT on the real KVNamespace. */
  _has(key: string): boolean {
    return this.store.has(key);
  }
  _ttl(key: string): number | undefined {
    return this.store.get(key)?.expirationTtl;
  }
  _size(): number {
    return this.store.size;
  }
  _setRaw(key: string, value: string): void {
    this.store.set(key, { value });
  }
}

function fakeKv(): KVNamespace & FakeKV {
  return new FakeKV() as unknown as KVNamespace & FakeKV;
}

describe("upload-slot-token", () => {
  let kv: ReturnType<typeof fakeKv>;

  beforeEach(() => {
    kv = fakeKv();
  });

  describe("issueUploadSlot", () => {
    it("creates a token + stores claims under the prefixed key", async () => {
      const result = await issueUploadSlot(kv, {
        targetType: "event",
        targetId: "event-id-1",
        issuedBy: "admin-1",
      });

      expect(result.token).toBeTruthy();
      expect(result.token.length).toBeGreaterThanOrEqual(16);
      expect(kv._has(`${__testing.KV_PREFIX}${result.token}`)).toBe(true);
      expect(result.maxBytes).toBe(__testing.MAX_BYTES_DEFAULT);
      // expires_at = now + SLOT_TTL_SECONDS; sanity-check the window.
      const expectedExpMs = Date.now() + __testing.SLOT_TTL_SECONDS * 1000;
      expect(Math.abs(result.expiresAt.getTime() - expectedExpMs)).toBeLessThan(2000);
    });

    it("sets KV expirationTtl to SLOT_TTL_SECONDS", async () => {
      const { token } = await issueUploadSlot(kv, {
        targetType: "vendor",
        targetId: "v-1",
        issuedBy: "admin",
      });
      expect(kv._ttl(`${__testing.KV_PREFIX}${token}`)).toBe(__testing.SLOT_TTL_SECONDS);
    });

    it("honors a caller-supplied maxBytes override", async () => {
      const result = await issueUploadSlot(kv, {
        targetType: "venue",
        targetId: "v-1",
        issuedBy: "admin",
        maxBytes: 5 * 1024 * 1024,
      });
      expect(result.maxBytes).toBe(5 * 1024 * 1024);
    });

    it("issues unique tokens across calls", async () => {
      const t1 = await issueUploadSlot(kv, {
        targetType: "event",
        targetId: "e-1",
        issuedBy: "admin",
      });
      const t2 = await issueUploadSlot(kv, {
        targetType: "event",
        targetId: "e-1",
        issuedBy: "admin",
      });
      expect(t1.token).not.toBe(t2.token);
      expect(kv._size()).toBe(2);
    });
  });

  describe("consumeUploadSlot", () => {
    it("returns claims and deletes the KV entry (one-shot)", async () => {
      const { token } = await issueUploadSlot(kv, {
        targetType: "vendor",
        targetId: "vendor-7",
        issuedBy: "admin-9",
        caption: "test caption",
      });

      const claims = await consumeUploadSlot(kv, token);
      expect(claims).not.toBeNull();
      expect(claims!.targetType).toBe("vendor");
      expect(claims!.targetId).toBe("vendor-7");
      expect(claims!.issuedBy).toBe("admin-9");
      expect(claims!.caption).toBe("test caption");
      expect(claims!.maxBytes).toBe(__testing.MAX_BYTES_DEFAULT);
      expect(kv._has(`${__testing.KV_PREFIX}${token}`)).toBe(false);
    });

    it("second consume returns null (replay protection)", async () => {
      const { token } = await issueUploadSlot(kv, {
        targetType: "event",
        targetId: "e-1",
        issuedBy: "admin",
      });
      const first = await consumeUploadSlot(kv, token);
      const second = await consumeUploadSlot(kv, token);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it("returns null for unknown token", async () => {
      expect(await consumeUploadSlot(kv, "not-a-real-token-string")).toBeNull();
    });

    it("returns null for empty / short token without touching KV", async () => {
      expect(await consumeUploadSlot(kv, "")).toBeNull();
      expect(await consumeUploadSlot(kv, "abc")).toBeNull();
    });

    it("returns null for excessively long token (defensive)", async () => {
      const huge = "a".repeat(300);
      expect(await consumeUploadSlot(kv, huge)).toBeNull();
    });

    it("returns null when KV value is corrupt JSON", async () => {
      kv._setRaw(`${__testing.KV_PREFIX}corrupt-token-aaaaaa`, "{not-json");
      expect(await consumeUploadSlot(kv, "corrupt-token-aaaaaa")).toBeNull();
    });

    it("returns null when KV value is JSON but missing required fields", async () => {
      kv._setRaw(
        `${__testing.KV_PREFIX}partial-token-bbbbb`,
        JSON.stringify({ targetType: "event" })
      );
      expect(await consumeUploadSlot(kv, "partial-token-bbbbb")).toBeNull();
    });

    it("returns null when targetType is not one of the allowed values", async () => {
      kv._setRaw(
        `${__testing.KV_PREFIX}bad-type-aaaaaaaa`,
        JSON.stringify({
          // "promoter" became valid in OPE-33 — use a genuinely-unknown type here.
          targetType: "spaceship",
          targetId: "x",
          maxBytes: 100,
          issuedAt: Date.now(),
          issuedBy: "admin",
        })
      );
      expect(await consumeUploadSlot(kv, "bad-type-aaaaaaaa")).toBeNull();
    });

    it("round-trips a promoter slot with its imageRole (OPE-33)", async () => {
      const issued = await issueUploadSlot(kv, {
        targetType: "promoter",
        targetId: "promoter-1",
        imageRole: "hero",
        issuedBy: "admin",
      });
      const claims = await consumeUploadSlot(kv, issued.token);
      expect(claims).toMatchObject({ targetType: "promoter", imageRole: "hero" });
    });
  });

  describe("peekUploadSlot (test-only)", () => {
    it("returns claims without consuming the entry", async () => {
      const { token } = await issueUploadSlot(kv, {
        targetType: "venue",
        targetId: "vnu-1",
        issuedBy: "admin",
      });
      const peeked = await peekUploadSlot(kv, token);
      expect(peeked).not.toBeNull();
      expect(peeked!.targetType).toBe("venue");
      // Still in KV after the peek.
      expect(kv._has(`${__testing.KV_PREFIX}${token}`)).toBe(true);
    });
  });
});
