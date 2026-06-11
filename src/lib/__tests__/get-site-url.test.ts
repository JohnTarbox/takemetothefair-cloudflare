import { getCloudflareContext } from "@opennextjs/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSiteUrl } from "@/lib/email/send";

/**
 * Regression guard for the apex Host-leak (K2, 2026-06-07): getSiteUrl must
 * resolve to the env override or the hardcoded production apex, and must NEVER
 * derive the host from the incoming request — behind the apex proxy the request
 * host is takemetothefair.pages.dev, which previously leaked into verification /
 * reset / newsletter email links. getRuntimeEnv reads the Cloudflare binding
 * env (getCloudflareContext().env), which the global test setup mocks; we drive
 * NEXT_PUBLIC_SITE_URL through that mock here.
 */
const mockEnv = (env: Record<string, unknown>) =>
  vi
    .mocked(getCloudflareContext)
    .mockReturnValue({ env } as unknown as ReturnType<typeof getCloudflareContext>);

describe("getSiteUrl", () => {
  afterEach(() => {
    vi.mocked(getCloudflareContext).mockReset();
  });

  it("returns the production apex when no override is set (never pages.dev)", () => {
    mockEnv({});
    expect(getSiteUrl()).toBe("https://meetmeatthefair.com");
  });

  it("honors the NEXT_PUBLIC_SITE_URL override for dev/staging", () => {
    mockEnv({ NEXT_PUBLIC_SITE_URL: "https://staging.example.com" });
    expect(getSiteUrl()).toBe("https://staging.example.com");
  });

  it("strips a trailing slash from the override", () => {
    mockEnv({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000/" });
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });
});
