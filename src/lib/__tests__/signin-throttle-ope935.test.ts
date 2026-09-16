/**
 * OPE-935 — sign-in is throttled per IP AND per account, BEFORE the password is
 * checked. Driven through `authorizeCredentials` (the real Credentials authorize
 * body) and the real `signInThrottle` + `getBurstLimiter` adapter, over a fake
 * Durable Object namespace that counts per key the way BurstCounter does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeEnv {
  BURST_COUNTER?: ReturnType<typeof makeNamespace>;
}
let fakeEnv: FakeEnv | null = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (fakeEnv === null) throw new Error("no request context");
    return { env: fakeEnv, ctx: { waitUntil: () => {} } };
  },
}));
const deployed = { value: true };
vi.mock("@/lib/runtime-env", () => ({ isDeployedEnvironment: () => deployed.value }));

import { authorizeCredentials, type CredentialsUser } from "../auth/credentials-authorize";
import { signInThrottle, signInKeys } from "../auth/signin-throttle";

/** Counts hits per key, admits `limit` per key — BurstCounter's contract. */
function makeNamespace(opts: { throws?: boolean } = {}) {
  const counts = new Map<string, number>();
  return {
    counts,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      hit: async (limit: number, period: number) => {
        if (opts.throws) throw new Error("Durable Object is overloaded");
        const c = (counts.get(id) ?? 0) + 1;
        counts.set(id, c);
        return { success: c <= limit, count: c, retryAfterSeconds: period };
      },
    }),
  };
}

const USERS: Record<string, CredentialsUser> = {
  "admin@example.com": {
    id: "u-admin",
    email: "admin@example.com",
    name: "Admin",
    image: null,
    role: "ADMIN",
    passwordHash: "salt:hash-admin",
  },
  "vendor@example.com": {
    id: "u-vendor",
    email: "vendor@example.com",
    name: "Vendor",
    image: null,
    role: "VENDOR",
    passwordHash: "salt:hash-vendor",
  },
};
const PASSWORDS: Record<string, string> = {
  "salt:hash-admin": "correct-admin",
  "salt:hash-vendor": "correct-vendor",
};

function makeDeps() {
  const verifyPassword = vi.fn(async (pw: string, hash: string) => PASSWORDS[hash] === pw);
  const onRefusedByThrottle = vi.fn();
  return {
    verifyPassword,
    onRefusedByThrottle,
    deps: {
      throttle: signInThrottle,
      findUserByEmail: async (email: string) => USERS[email],
      verifyPassword,
      onRefusedByThrottle,
      logAuthError: async () => {},
    },
  };
}

const req = (ip: string) =>
  new Request("https://meetmeatthefair.com/api/auth/callback/credentials", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
  });

beforeEach(() => {
  fakeEnv = { BURST_COUNTER: makeNamespace() };
  deployed.value = true;
});

describe("OPE-935 — the acceptance test", () => {
  it("the 6th wrong password for one email from one IP is refused WITHOUT calling verifyPassword", async () => {
    const { deps, verifyPassword, onRefusedByThrottle } = makeDeps();
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await authorizeCredentials(
          { email: "admin@example.com", password: `guess-${i}` },
          req("198.51.100.7"),
          deps
        )
      );
    }
    expect(results.every((r) => r === null)).toBe(true);
    expect(verifyPassword).toHaveBeenCalledTimes(5); // the 6th never reached it
    expect(onRefusedByThrottle).toHaveBeenCalledTimes(1);

    // POSITIVE LANDMARK: a different account, from a different IP, in the same
    // window, with the right password, signs in.
    const ok = await authorizeCredentials(
      { email: "vendor@example.com", password: "correct-vendor" },
      req("203.0.113.9"),
      deps
    );
    expect(ok).toMatchObject({ id: "u-vendor", role: "VENDOR" });
  });

  it("one ACCOUNT guessed from many IPs is refused on the account key", async () => {
    const { deps, verifyPassword } = makeDeps();
    for (let i = 0; i < 6; i++) {
      await authorizeCredentials(
        { email: "admin@example.com", password: "nope" },
        req(`192.0.2.${i + 1}`),
        deps
      );
    }
    expect(verifyPassword).toHaveBeenCalledTimes(5);
  });

  it("the refusal looks exactly like a wrong password (null), for a real AND an unknown email", async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 5; i++) {
      await authorizeCredentials(
        { email: "ghost@example.com", password: "x" },
        req("198.51.100.8"),
        deps
      );
    }
    const unknown = await authorizeCredentials(
      { email: "ghost@example.com", password: "x" },
      req("198.51.100.8"),
      deps
    );
    expect(unknown).toBeNull();
  });

  it("the account key is case-insensitive and never carries the address", async () => {
    const a = await signInKeys(req("1.1.1.1"), "Admin@Example.com");
    const b = await signInKeys(req("1.1.1.1"), "admin@example.com");
    expect(a.account).toBe(b.account);
    expect(a.account).not.toContain("admin");
    expect(a.ip).toBe("rate:auth-signin:ip:1.1.1.1");
  });
});

describe("OPE-935 — failure posture", () => {
  it("NO binding on a deployed Worker → refused (fail closed), and the password is never checked", async () => {
    fakeEnv = {};
    const { deps, verifyPassword } = makeDeps();
    const r = await authorizeCredentials(
      { email: "vendor@example.com", password: "correct-vendor" },
      req("203.0.113.9"),
      deps
    );
    expect(r).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("NO binding off a deployed Worker (tests, next dev) → allowed", async () => {
    fakeEnv = {};
    deployed.value = false;
    const { deps } = makeDeps();
    const r = await authorizeCredentials(
      { email: "vendor@example.com", password: "correct-vendor" },
      req("203.0.113.9"),
      deps
    );
    expect(r).toMatchObject({ id: "u-vendor" });
  });

  it("a THROWING counter allows the attempt and logs, rather than locking everyone out", async () => {
    fakeEnv = { BURST_COUNTER: makeNamespace({ throws: true }) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps();
    const r = await authorizeCredentials(
      { email: "vendor@example.com", password: "correct-vendor" },
      req("203.0.113.9"),
      deps
    );
    expect(r).toMatchObject({ id: "u-vendor" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("the placeholder refusal still happens first and spends no budget", async () => {
    const ns = makeNamespace();
    fakeEnv = { BURST_COUNTER: ns };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps();
    await authorizeCredentials(
      { email: "pending+some-vendor@meetmeatthefair.com", password: "x" },
      req("203.0.113.9"),
      deps
    );
    expect(ns.counts.size).toBe(0);
    warn.mockRestore();
  });
});

describe("OPE-935 — the real provider uses this path", () => {
  it("auth.ts's Credentials authorize delegates to authorizeCredentials with signInThrottle", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "auth.ts"), "utf8");
    expect(src).toMatch(/async authorize\(credentials, request\) \{/);
    expect(src).toMatch(/return authorizeCredentials\(credentials, request, \{/);
    expect(src).toMatch(/throttle: signInThrottle,/);
    // The inline password check it replaced must not survive beside it.
    expect(src).not.toMatch(/verifyPassword\(credentials\.password/);
  });
});
