import { vi } from "vitest";

// Mock server-only (required by @cloudflare/next-on-pages)
vi.mock("server-only", () => ({}));

// Mock @cloudflare/next-on-pages
vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: vi.fn(() => ({
    env: {
      DB: {},
      AI: {},
      RATE_LIMIT_KV: {},
    },
  })),
}));

// Mock Next.js navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next-auth
vi.mock("next-auth", () => ({
  default: vi.fn(),
}));

// Mock Cloudflare DB helper
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    batch: vi.fn().mockResolvedValue([]),
    query: {
      users: { findFirst: vi.fn() },
      events: { findFirst: vi.fn(), findMany: vi.fn() },
      venues: { findFirst: vi.fn(), findMany: vi.fn() },
      vendors: { findFirst: vi.fn(), findMany: vi.fn() },
      promoters: { findFirst: vi.fn(), findMany: vi.fn() },
    },
  })),
  getCloudflareEnv: vi.fn(() => ({})),
  getCloudflareAi: vi.fn(() => ({})),
  getCloudflareRateLimitKv: vi.fn(() => null),
}));

// Mock crypto.subtle for tests (not available in jsdom by default)
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      subtle: {
        digest: async (algorithm: string, data: ArrayBuffer) => {
          // Simple mock for testing - just return a fixed hash
          const { createHash } = await import("crypto");
          const hash = createHash("sha256");
          hash.update(Buffer.from(data));
          return hash.digest();
        },
      },
      randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2),
    },
  });
}
