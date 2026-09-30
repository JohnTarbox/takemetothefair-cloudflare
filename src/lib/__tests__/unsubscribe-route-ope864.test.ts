/**
 * OPE-864 — the Path B route accepts the sealed `/unsubscribe/v2/<sealed>`
 * form AND every legacy `/unsubscribe/<b64-email>/<hmac>` link already in
 * inboxes; a tampered seal suppresses nobody.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  base64UrlEncode,
  buildUnsubscribeUrl,
  computeUnsubscribeToken,
} from "@takemetothefair/utils";

const SECRET = "route-test-secret";
const optOut = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: () => ({ UNSUBSCRIBE_SECRET: SECRET }),
  getCloudflareDb: () => ({}),
}));
vi.mock("@/lib/email/unsubscribe-stores", () => ({
  applyGlobalOptOut: async (_db: unknown, addr: string) => {
    optOut.calls.push(addr);
  },
}));
vi.mock("@/lib/logger", () => ({ logError: async () => {} }));

import { GET } from "@/app/unsubscribe/[e]/[t]/route";

const call = (e: string, t: string) =>
  GET(new Request(`https://x.test/unsubscribe/${e}/${t}`), {
    params: Promise.resolve({ e, t }),
  });

beforeEach(() => {
  optOut.calls = [];
});

describe("Path B unsubscribe route", () => {
  it("ACCEPTANCE: a sealed v2 link unsubscribes exactly its recipient", async () => {
    const url = await buildUnsubscribeUrl("https://meetmeatthefair.com", SECRET, "owner@acme.test");
    const [, , , , e, t] = url.split("/");
    expect(e).toBe("v2");
    const res = await call(e, t);
    expect(res.status).toBe(200);
    expect(optOut.calls).toEqual(["owner@acme.test"]);
  });

  it("a tampered seal is refused and suppresses NOBODY", async () => {
    const url = await buildUnsubscribeUrl("https://meetmeatthefair.com", SECRET, "owner@acme.test");
    const t = url.split("/").pop()!;
    const i = Math.floor(t.length / 2);
    const bad = `${t.slice(0, i)}${t[i] === "A" ? "B" : "A"}${t.slice(i + 1)}`;
    const res = await call("v2", bad);
    expect(res.status).toBe(400);
    expect(optOut.calls).toEqual([]);
  });

  it("a seal made under another secret is refused", async () => {
    const url = await buildUnsubscribeUrl("https://meetmeatthefair.com", "not-ours", "a@b.co");
    const res = await call("v2", url.split("/").pop()!);
    expect(res.status).toBe(400);
    expect(optOut.calls).toEqual([]);
  });

  it("a LEGACY b64-email + hmac link still works", async () => {
    const token = await computeUnsubscribeToken(SECRET, "legacy@acme.test");
    const res = await call(base64UrlEncode("legacy@acme.test"), token);
    expect(res.status).toBe(200);
    expect(optOut.calls).toEqual(["legacy@acme.test"]);
  });
});
