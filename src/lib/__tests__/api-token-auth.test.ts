import { describe, it, expect, vi, beforeEach } from "vitest";

// Drizzle's `select(...).from(...).where(...).limit(N)` chain — `select`
// is called twice in the function under test (once for the token row,
// once for the vendor row), so the mock has to return two different
// terminal results per test. We do that by stubbing `limit` to read
// from a queue of results.
const limitResults: Array<unknown[]> = [];

const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(async () => limitResults.shift() ?? []),
  update: vi.fn(() => updateChain),
};

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => mockDb),
}));

import { authenticateVendorToken } from "../api-token-auth";

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set("Authorization", authHeader);
  return new Request("https://example.com/api/vendor/x", { headers });
}

describe("authenticateVendorToken", () => {
  beforeEach(() => {
    limitResults.length = 0;
    vi.clearAllMocks();
    updateChain.where.mockResolvedValue(undefined);
  });

  describe("header validation", () => {
    it("rejects request with no Authorization header", async () => {
      const result = await authenticateVendorToken(makeRequest(), "acme");
      expect(result).toEqual({
        authorized: false,
        error: "Missing or invalid Authorization header",
      });
    });

    it("rejects Authorization header that doesn't start with Bearer", async () => {
      const result = await authenticateVendorToken(makeRequest("Basic foo"), "acme");
      expect(result).toEqual({
        authorized: false,
        error: "Missing or invalid Authorization header",
      });
    });

    it("rejects token without the mmatf_ prefix", async () => {
      const result = await authenticateVendorToken(makeRequest("Bearer wrong_prefix"), "acme");
      expect(result).toEqual({ authorized: false, error: "Invalid token format" });
    });
  });

  describe("token lookup", () => {
    it("rejects when no token row matches the hash", async () => {
      limitResults.push([]); // token lookup returns empty
      const result = await authenticateVendorToken(makeRequest("Bearer mmatf_unknown"), "acme");
      expect(result).toEqual({ authorized: false, error: "Invalid token" });
    });

    it("returns vendorId on full happy path", async () => {
      limitResults.push([{ userId: "user-1" }]); // token lookup
      limitResults.push([{ id: "vendor-1" }]); // vendor lookup
      const result = await authenticateVendorToken(makeRequest("Bearer mmatf_valid"), "acme");
      expect(result).toEqual({ authorized: true, vendorId: "vendor-1" });
    });

    it("rejects when the token's user does not own the requested vendor slug", async () => {
      limitResults.push([{ userId: "user-1" }]); // token lookup
      limitResults.push([]); // vendor lookup — no match
      const result = await authenticateVendorToken(
        makeRequest("Bearer mmatf_valid"),
        "someone-elses-vendor"
      );
      expect(result).toEqual({ authorized: false, error: "Token does not match this vendor" });
    });
  });

  describe("lastUsedAt fire-and-forget update", () => {
    it("kicks off the update on a successful auth", async () => {
      limitResults.push([{ userId: "user-1" }]);
      limitResults.push([{ id: "vendor-1" }]);
      await authenticateVendorToken(makeRequest("Bearer mmatf_valid"), "acme");
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastUsedAt: expect.any(Date) })
      );
    });

    it("logs to console.error when the update rejects, instead of throwing", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      limitResults.push([{ userId: "user-1" }]);
      limitResults.push([{ id: "vendor-1" }]);
      const dbErr = new Error("D1_ERROR: connection lost");
      updateChain.where.mockRejectedValueOnce(dbErr);

      const result = await authenticateVendorToken(makeRequest("Bearer mmatf_valid"), "acme");
      expect(result).toEqual({ authorized: true, vendorId: "vendor-1" });

      // The .catch handler runs after the function returns — flush microtasks.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(consoleSpy).toHaveBeenCalledWith("[API Token] Failed to update lastUsedAt:", dbErr);
      consoleSpy.mockRestore();
    });

    it("does not block the auth path when the update is slow", async () => {
      limitResults.push([{ userId: "user-1" }]);
      limitResults.push([{ id: "vendor-1" }]);
      // Update never resolves within the test window — auth must still return.
      updateChain.where.mockReturnValueOnce(new Promise(() => {}));

      const result = await authenticateVendorToken(makeRequest("Bearer mmatf_valid"), "acme");
      expect(result).toEqual({ authorized: true, vendorId: "vendor-1" });
    });
  });

  describe("token hashing", () => {
    it("hashes the same input deterministically across requests", async () => {
      // Two consecutive auth attempts with the same token should issue
      // identical lookup arguments to the DB (proving the SHA-256 hash
      // is stable, so a stored hash will match on every future request).
      limitResults.push([{ userId: "u" }]);
      limitResults.push([{ id: "v" }]);
      limitResults.push([{ userId: "u" }]);
      limitResults.push([{ id: "v" }]);

      await authenticateVendorToken(makeRequest("Bearer mmatf_same"), "acme");
      const firstWhereCall = mockDb.where.mock.calls[0];
      mockDb.where.mockClear();

      await authenticateVendorToken(makeRequest("Bearer mmatf_same"), "acme");
      const secondWhereCall = mockDb.where.mock.calls[0];

      expect(firstWhereCall).toEqual(secondWhereCall);
    });
  });
});
