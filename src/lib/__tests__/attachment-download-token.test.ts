/**
 * OPE-409 — short-lived download slots for inbound-email attachments.
 *
 * The slot is what makes closing the public `inbound-attachments/` prefix
 * possible without breaking recovery. John's condition, verbatim: *"Don't block
 * until you have a way to access. It is only the public that should be blocked,
 * not you."*
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  issueAttachmentDownloadSlot,
  resolveAttachmentDownloadSlot,
  revokeAttachmentDownloadSlot,
  ATTACHMENT_DOWNLOAD_TTL_SECONDS,
} from "../attachment-download-token";

/** In-memory fake of the KVNamespace subset this module uses. */
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

let kv: FakeKV;
beforeEach(() => {
  kv = new FakeKV();
});
const asKv = () => kv as unknown as KVNamespace;

const ARGS = { inboundEmailId: "e1", index: 0, issuedBy: "mcp-worker" };

describe("issuing a slot", () => {
  it("round-trips the claims", async () => {
    const { token } = await issueAttachmentDownloadSlot(asKv(), ARGS);
    const claims = await resolveAttachmentDownloadSlot(asKv(), token);
    expect(claims).toEqual({
      inboundEmailId: "e1",
      index: 0,
      issuedAt: expect.any(Number),
      issuedBy: "mcp-worker",
    });
  });

  it("stores a native TTL so nothing has to sweep it", async () => {
    const { token, ttlSeconds } = await issueAttachmentDownloadSlot(asKv(), ARGS);
    expect(ttlSeconds).toBe(ATTACHMENT_DOWNLOAD_TTL_SECONDS);
    expect(kv._ttl("attachment-download:" + token)).toBe(ATTACHMENT_DOWNLOAD_TTL_SECONDS);
  });

  it("expires — which is the entire point of the ticket", async () => {
    // The complaint about the CDN keys is not that they are readable, it is
    // that they are readable FOREVER with no revocation. A replacement without
    // a TTL would just be the same defect on a different hostname.
    expect(ATTACHMENT_DOWNLOAD_TTL_SECONDS).toBeGreaterThan(0);
    expect(ATTACHMENT_DOWNLOAD_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it("mints an unguessable, unique token each time", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tokens.add((await issueAttachmentDownloadSlot(asKv(), ARGS)).token);
    }
    expect(tokens.size).toBe(50);
    // 24 random bytes → 32 base64url chars.
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  it("scopes a token to ONE attachment, never a prefix", async () => {
    const a = await issueAttachmentDownloadSlot(asKv(), { ...ARGS, index: 0 });
    const b = await issueAttachmentDownloadSlot(asKv(), { ...ARGS, index: 1 });
    expect((await resolveAttachmentDownloadSlot(asKv(), a.token))?.index).toBe(0);
    expect((await resolveAttachmentDownloadSlot(asKv(), b.token))?.index).toBe(1);
  });
});

describe("resolving is deliberately NOT one-shot", () => {
  it("serves the same slot repeatedly within its TTL", async () => {
    // This is where it departs from K17's upload slot, which deletes on read.
    // The recovery flow is: fetch the object, THEN hand the same URL to
    // upload_event_image — two reads of one URL. A one-shot token fails the
    // second, and it fails as a 404 that reads like a missing attachment
    // rather than like a spent token. The replay bound here is the TTL.
    const { token } = await issueAttachmentDownloadSlot(asKv(), ARGS);
    expect(await resolveAttachmentDownloadSlot(asKv(), token)).not.toBeNull();
    expect(await resolveAttachmentDownloadSlot(asKv(), token)).not.toBeNull();
    expect(await resolveAttachmentDownloadSlot(asKv(), token)).not.toBeNull();
  });

  it("can still be revoked early", async () => {
    const { token } = await issueAttachmentDownloadSlot(asKv(), ARGS);
    await revokeAttachmentDownloadSlot(asKv(), token);
    expect(await resolveAttachmentDownloadSlot(asKv(), token)).toBeNull();
    expect(kv._size()).toBe(0);
  });
});

describe("rejecting bad tokens", () => {
  it("returns null for an unknown token", async () => {
    expect(await resolveAttachmentDownloadSlot(asKv(), "nope-nope-nope-nope")).toBeNull();
  });

  it("returns null for absurd token lengths without touching KV", async () => {
    expect(await resolveAttachmentDownloadSlot(asKv(), "")).toBeNull();
    expect(await resolveAttachmentDownloadSlot(asKv(), "short")).toBeNull();
    expect(await resolveAttachmentDownloadSlot(asKv(), "x".repeat(300))).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing", async () => {
    kv._setRaw("attachment-download:" + "t".repeat(32), "{not json");
    expect(await resolveAttachmentDownloadSlot(asKv(), "t".repeat(32))).toBeNull();
  });

  it("rejects structurally wrong claims", async () => {
    const cases = [
      {},
      { inboundEmailId: "", index: 0, issuedAt: 1, issuedBy: "x" },
      { inboundEmailId: "e1", index: -1, issuedAt: 1, issuedBy: "x" },
      { inboundEmailId: "e1", index: 1.5, issuedAt: 1, issuedBy: "x" },
      { inboundEmailId: "e1", index: "0", issuedAt: 1, issuedBy: "x" },
      { inboundEmailId: "e1", index: 0, issuedBy: "x" },
    ];
    for (const [i, c] of cases.entries()) {
      const tok = String(i).padStart(32, "z");
      kv._setRaw("attachment-download:" + tok, JSON.stringify(c));
      expect(await resolveAttachmentDownloadSlot(asKv(), tok)).toBeNull();
    }
  });
});
