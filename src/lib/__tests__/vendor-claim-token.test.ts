import { describe, it, expect, vi, beforeEach } from "vitest";

// Drizzle chain mock — select(...).from(...).where(...).limit(N) and
// insert(...).values(...) and delete(...).where(...). Tests stage
// per-call return values via the limitResults / insertCalls / deleteCalls
// queues.
const limitResults: Array<unknown[]> = [];
const insertCalls: Array<unknown> = [];
const deleteCalls: Array<unknown> = [];

const insertChain = {
  values: vi.fn(async (v: unknown) => {
    insertCalls.push(v);
  }),
};

const deleteChain = {
  where: vi.fn(async () => {
    deleteCalls.push("delete");
  }),
};

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(async () => limitResults.shift() ?? []),
  insert: vi.fn(() => insertChain),
  delete: vi.fn(() => deleteChain),
};

import { consumeClaimToken, createClaimToken } from "../vendor-claim-token";

type TestDb = Parameters<typeof createClaimToken>[0];

beforeEach(() => {
  limitResults.length = 0;
  insertCalls.length = 0;
  deleteCalls.length = 0;
  vi.clearAllMocks();
});

describe("createClaimToken", () => {
  it("inserts a hashed token row and returns the raw token + expiry", async () => {
    const result = await createClaimToken(mockDb as unknown as TestDb, {
      vendorId: "vendor-1",
      userId: "user-1",
    });
    expect(result.rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    expect(insertCalls).toHaveLength(1);
    const inserted = insertCalls[0] as {
      vendorId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
    };
    expect(inserted.vendorId).toBe("vendor-1");
    expect(inserted.userId).toBe("user-1");
    expect(inserted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted.tokenHash).not.toBe(result.rawToken); // hash != raw
  });

  it("never reuses tokens", async () => {
    const a = await createClaimToken(mockDb as unknown as TestDb, {
      vendorId: "v",
      userId: "u",
    });
    const b = await createClaimToken(mockDb as unknown as TestDb, {
      vendorId: "v",
      userId: "u",
    });
    expect(a.rawToken).not.toBe(b.rawToken);
  });
});

describe("consumeClaimToken", () => {
  it("returns not_found when no row matches the hash", async () => {
    limitResults.push([]); // first .limit() call: no token row
    const r = await consumeClaimToken(mockDb as unknown as TestDb, "deadbeef");
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(deleteCalls).toHaveLength(0);
  });

  it("returns expired when token is past expiry, and deletes it", async () => {
    const past = new Date(Date.now() - 60_000);
    limitResults.push([
      {
        id: "tok-1",
        vendorId: "v",
        userId: "u",
        tokenHash: "h",
        createdAt: new Date(),
        expiresAt: past,
      },
    ]);
    const r = await consumeClaimToken(mockDb as unknown as TestDb, "raw");
    expect(r).toEqual({ ok: false, reason: "expired" });
    expect(deleteCalls).toHaveLength(1);
  });

  it("returns ok and deletes on successful consume", async () => {
    const future = new Date(Date.now() + 60_000);
    // First .limit(): token row exists and is not expired.
    limitResults.push([
      {
        id: "tok-1",
        vendorId: "vendor-1",
        userId: "user-1",
        tokenHash: "h",
        createdAt: new Date(),
        expiresAt: future,
      },
    ]);
    // Second .limit(): vendor row exists with matching userId.
    limitResults.push([{ id: "vendor-1", userId: "user-1", claimed: false }]);
    const r = await consumeClaimToken(mockDb as unknown as TestDb, "raw");
    expect(r).toEqual({ ok: true, vendorId: "vendor-1", userId: "user-1" });
    expect(deleteCalls).toHaveLength(1); // single-use: deleted
  });

  it("returns not_found when the vendor's userId no longer matches", async () => {
    const future = new Date(Date.now() + 60_000);
    limitResults.push([
      {
        id: "tok-1",
        vendorId: "vendor-1",
        userId: "user-1",
        tokenHash: "h",
        createdAt: new Date(),
        expiresAt: future,
      },
    ]);
    // Vendor's userId got reassigned between initiate and confirm.
    limitResults.push([{ id: "vendor-1", userId: "user-2", claimed: false }]);
    const r = await consumeClaimToken(mockDb as unknown as TestDb, "raw");
    expect(r).toEqual({ ok: false, reason: "not_found" });
    expect(deleteCalls).toHaveLength(1);
  });
});
