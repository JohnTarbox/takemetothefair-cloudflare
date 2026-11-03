/**
 * OPE-1346 — the SHIPPED unsubscribe routes accept a link signed under the old
 * key after UNSUBSCRIBE_SECRET is introduced. The helpers are unit-tested in
 * packages/utils; this proves the routes actually call them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnsubscribeUrl, computeUnsubscribeToken } from "@takemetothefair/utils";

const env: Record<string, string | undefined> = {};
const suppressed: string[] = [];

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: () => env,
  getCloudflareDb: () => ({}),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/unsubscribe-stores", () => ({
  applyGlobalOptOut: vi.fn(async (_db: unknown, addr: string) => {
    suppressed.push(addr);
  }),
}));

const OLD = "internal-key-signed-every-link-so-far";
const NEW = "dedicated-unsubscribe-key";
const EMAIL = "organizer@example.com";

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  env.INTERNAL_API_KEY = OLD;
  env.UNSUBSCRIBE_SECRET = NEW; // step (a) of the runbook has happened
  suppressed.length = 0;
});

describe("unsubscribe routes after UNSUBSCRIBE_SECRET is set (OPE-1346)", () => {
  it("a sealed /v2 link signed under INTERNAL_API_KEY before the change still unsubscribes", async () => {
    const url = await buildUnsubscribeUrl("https://meetmeatthefair.com", OLD, EMAIL);
    const sealed = url.split("/v2/")[1];
    const { GET } = await import("../[e]/[t]/route");
    const res = await GET(new Request(url), { params: Promise.resolve({ e: "v2", t: sealed }) });
    expect(res.status).toBe(200);
    expect(suppressed).toEqual([EMAIL]);
  });

  it("a legacy path-form HMAC link under the old key still unsubscribes", async () => {
    const token = await computeUnsubscribeToken(OLD, EMAIL);
    const e = btoa(EMAIL).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const { GET } = await import("../[e]/[t]/route");
    const res = await GET(new Request(`https://x/unsubscribe/${e}/${token}`), {
      params: Promise.resolve({ e, t: token }),
    });
    expect(res.status).toBe(200);
  });

  it("the legacy query form under the old key still unsubscribes", async () => {
    const token = await computeUnsubscribeToken(OLD, EMAIL);
    const { GET } = await import("../route");
    const res = await GET(
      new Request(`https://x/unsubscribe?e=${encodeURIComponent(EMAIL)}&t=${token}`)
    );
    expect(res.status).toBe(200);
  });

  it("a link under an unknown key is refused, and nothing is suppressed", async () => {
    const url = await buildUnsubscribeUrl("https://meetmeatthefair.com", "not-ours", EMAIL);
    const { GET } = await import("../[e]/[t]/route");
    const res = await GET(new Request(url), {
      params: Promise.resolve({ e: "v2", t: url.split("/v2/")[1] }),
    });
    expect(res.status).toBe(400);
    expect(suppressed).toEqual([]);
  });
});
