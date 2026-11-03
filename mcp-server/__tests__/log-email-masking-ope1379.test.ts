/**
 * OPE-1379 (HARD8) — sender / recipient addresses are MASKED in log context and
 * console lines ("j***@example.com"), never written verbatim.
 *
 * The audit found real addresses in `error_logs.context` from the inbound email
 * handler (email-handler.ts — parse failure, audit-noop, held-automated), the
 * email queue consumer (queue-consumers.ts — held reply, sent, failed), and the
 * OAuth login form (login-handler.ts — console.log of user.email, plus the
 * failed-login context). These tests drive each surface for real and spy on
 * `logError` / `console`, then a source sweep pins that no log context in those
 * files hands a raw address to the logger again.
 *
 * The data columns that legitimately store an address (inbound_emails
 * .from_address, email_send_ledger.recipient) must keep the REAL value — one
 * assertion per surface pins that, so the masking cannot over-reach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, inboundEmails } from "../src/schema.js";
import { makeFakeBurstCounter } from "./_mocks/fake-burst-counter.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
const logError = vi.fn(async () => {});
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

const verifyPassword = vi.fn(async (password: string) => password === "correct-horse");
vi.mock("../src/oauth/utils.js", () => ({
  lookupUser: async (_db: unknown, email: string) =>
    email === "john.doe@example.com"
      ? { id: "u1", email, passwordHash: "stored", role: "ADMIN" }
      : null,
  verifyPassword: (p: string) => verifyPassword(p),
  resolveUserProps: async () => ({ userId: "u1" }),
  isLegacyPasswordHash: () => false,
  upgradePasswordHash: async () => {},
}));

const { handleInboundEmail } = await import("../src/email-handler.js");
const { handleEmailBatch } = await import("../src/queue-consumers.js");
const { LoginHandler } = await import("../src/oauth/login-handler.js");

const here = dirname(fileURLToPath(import.meta.url));

/** Every serialized logError call, so an address anywhere in it is visible. */
function loggedText(): string {
  return JSON.stringify(logError.mock.calls.map((c) => (c as unknown[])[1]));
}
function contextsFor(message: RegExp): Record<string, unknown>[] {
  return logError.mock.calls
    .map((c) => (c as unknown[])[1] as { message: string; context?: Record<string, unknown> })
    .filter((o) => message.test(o.message))
    .map((o) => o.context ?? {});
}

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

beforeEach(() => {
  ({ db: harness.db } = createTestDb());
  logError.mockClear();
});

// ---------------------------------------------------------------------------
// email-handler.ts
// ---------------------------------------------------------------------------

function inbound(opts: { from: string; raw: ReadableStream | string; headers?: Headers }) {
  return {
    from: opts.from,
    to: "submit@meetmeatthefair.com",
    raw: opts.raw,
    rawSize: 321,
    headers: opts.headers ?? new Headers(),
    forward: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    setReject: vi.fn(),
  };
}

function handlerEnv() {
  return {
    DB: {} as D1Database,
    OAUTH_KV: makeKv(),
    MAIN_APP_URL: "https://main.example.test",
    INTERNAL_API_KEY: "k",
    // SUBMIT_ADMIN_FORWARD deliberately unset → the forward helper logs too.
  };
}

function rfc822(from: string, extraHeaders = ""): string {
  return [
    `From: ${from}`,
    "To: submit@meetmeatthefair.com",
    "Subject: Hello there",
    "Message-ID: <m-1@example.com>",
    extraHeaders,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body text.",
    "",
  ]
    .filter((l, i) => l !== "" || i > 4)
    .join("\r\n");
}

describe("email-handler.ts — inbound sender addresses are masked in log context", () => {
  it("PostalMime parse failure (and the admin-forward fallback) log a masked `from`", async () => {
    const raw = new ReadableStream({
      pull() {
        throw new Error("stream broke");
      },
    });
    const msg = inbound({ from: "jane.sender@example.org", raw });
    await handleInboundEmail(msg as never, handlerEnv() as never, {} as never);

    const [parseCtx] = contextsFor(/PostalMime parse failed/);
    expect(parseCtx).toBeDefined();
    expect(parseCtx.from).toBe("j***@example.org");
    const [fwdCtx] = contextsFor(/SUBMIT_ADMIN_FORWARD env not set/);
    expect(fwdCtx.from).toBe("j***@example.org");
    expect(loggedText()).not.toContain("jane.sender@");
  });

  it("audit-noop sender: the info row's `from` is masked; the stored row keeps the real address", async () => {
    const from = "no-reply@vendorportal.example";
    const msg = inbound({ from, raw: rfc822(from) });
    await handleInboundEmail(msg as never, handlerEnv() as never, {} as never);

    const [ctx] = contextsFor(/non-actionable audit\/system sender/);
    expect(ctx).toBeDefined();
    expect(ctx.from).toBe("n***@vendorportal.example");
    expect(loggedText()).not.toContain("no-reply@");

    // Data column untouched — the row still names the real sender.
    const rows = await harness.db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromAddress).toBe(from);
  });

  it("held-automated sender: the hold row's `from` is masked", async () => {
    const from = "fair.bot@countyfair.example";
    const msg = inbound({
      from,
      raw: rfc822(from, "Auto-Submitted: auto-generated"),
      headers: new Headers({ "Auto-Submitted": "auto-generated" }),
    });
    await handleInboundEmail(msg as never, handlerEnv() as never, {} as never);

    const [ctx] = contextsFor(/automated sender held/);
    expect(ctx).toBeDefined();
    expect(ctx.from).toBe("f***@countyfair.example");
    expect(loggedText()).not.toContain("fair.bot@");
    const rows = await harness.db.select().from(inboundEmails);
    expect(rows[0].fromAddress).toBe(from);
  });
});

// ---------------------------------------------------------------------------
// queue-consumers.ts
// ---------------------------------------------------------------------------

describe("queue-consumers.ts — outbound recipients are masked in console + log context", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  function job(source: string, to = "jane.recipient@example.net") {
    return {
      id: `q-${source}`,
      attempts: 1,
      body: { to, subject: "S", html: "<p>x</p>", text: "x", source },
      ack: vi.fn(),
      retry: vi.fn(),
    };
  }
  const consoleText = () => JSON.stringify([...consoleLog.mock.calls, ...consoleWarn.mock.calls]);

  it("sent: the console line masks the recipient; the ledger keeps the real one", async () => {
    const send = vi.fn(async () => ({ messageId: "prov-1" }));
    const m = job("auth.send-verification");
    await handleEmailBatch({ messages: [m] } as never, { DB: {}, EMAIL: { send } } as never);

    expect(send).toHaveBeenCalledTimes(1);
    expect(consoleText()).toContain("j***@example.net");
    expect(consoleText()).not.toContain("jane.recipient@");
    const [row] = await harness.db.select().from(emailSendLedger);
    expect(row.recipient).toBe("jane.recipient@example.net");
  });

  it("reply held (EMAIL_REPLY_ENABLED off): the console warn masks every recipient", async () => {
    const send = vi.fn();
    const m = job("reply:submit", "jane.recipient@example.net, bob.other@example.com");
    await handleEmailBatch({ messages: [m] } as never, { DB: {}, EMAIL: { send } } as never);

    expect(send).not.toHaveBeenCalled();
    expect(consoleText()).toContain("j***@example.net, b***@example.com");
    expect(consoleText()).not.toMatch(/jane\.recipient@|bob\.other@/);
  });

  it.each([
    ["permanent rejection", "Invalid email address: Invalid email user", /rejected permanently/],
    ["transient failure", "Network connection lost", /will retry via queue/],
  ])("%s: the logError context masks `to`", async (_l, err, msgRe) => {
    const send = vi.fn(async () => {
      throw new Error(err);
    });
    const m = job("auth.send-verification");
    await handleEmailBatch({ messages: [m] } as never, { DB: {}, EMAIL: { send } } as never);

    const [ctx] = contextsFor(msgRe);
    expect(ctx).toBeDefined();
    expect(ctx.to).toBe("j***@example.net");
    expect(loggedText()).not.toContain("jane.recipient@");
  });
});

// ---------------------------------------------------------------------------
// oauth/login-handler.ts
// ---------------------------------------------------------------------------

describe("oauth/login-handler.ts — the signing-in address is masked", () => {
  let env: Record<string, unknown>;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    env = {
      DB: {},
      OAUTH_KV: makeKv(),
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => ({
          clientId: "client-abc",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          scope: ["read"],
          state: "s",
        }),
        lookupClient: async () => ({
          clientId: "client-abc",
          clientName: "Claude",
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        }),
        completeAuthorization: async () => ({ redirectTo: "https://claude.ai/cb?code=x" }),
      },
      BURST_COUNTER: makeFakeBurstCounter().ns,
    };
  });
  afterEach(() => consoleLog.mockRestore());

  async function attempt(email: string, password: string) {
    const page = await LoginHandler.request("/authorize?client_id=client-abc", {}, env);
    const html = await page.text();
    const state = /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return LoginHandler.request(
      "/authorize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-CSRF=${csrf}`,
          "CF-Connecting-IP": "203.0.113.7",
        },
        body: new URLSearchParams({ csrf_token: csrf, email, password, state }).toString(),
      },
      env
    );
  }

  it("successful login: the console line masks user.email", async () => {
    const res = await attempt("john.doe@example.com", "correct-horse");
    expect(res.status).toBe(302);
    const text = JSON.stringify(consoleLog.mock.calls);
    expect(text).toContain("j***@example.com");
    expect(text).not.toContain("john.doe@");
  });

  it("wrong password and unknown email: the warn context masks the address", async () => {
    await attempt("john.doe@example.com", "wrong");
    await attempt("stranger@example.org", "whatever");
    expect(contextsFor(/password verification failed/)[0].email).toBe("j***@example.com");
    expect(contextsFor(/unknown email/)[0].email).toBe("s***@example.org");
    expect(loggedText()).not.toMatch(/john\.doe@|stranger@/);
  });
});

// ---------------------------------------------------------------------------
// Source sweep — the call sites above are examples; this pins every one.
// ---------------------------------------------------------------------------

describe("source sweep — no raw address handed to a log line in these files", () => {
  const read = (p: string) => readFileSync(resolve(here, "..", "src", p), "utf8");

  it("email-handler.ts: every `from:` context value is wrapped in maskEmail", () => {
    const src = read("email-handler.ts");
    // A raw sender in an object literal: `from: fromAddr` / `from: message.from`.
    const raw = src.match(/\bfrom: (?:fromAddr|message\.from)\b/g) ?? [];
    expect(raw).toEqual([]);
    // Non-vacuous: the masked form is actually present, many times.
    expect((src.match(/from: maskEmail\(/g) ?? []).length).toBeGreaterThanOrEqual(25);
  });

  it("queue-consumers.ts: `m.body.to` reaches only the ledger formatter or maskEmails", () => {
    const src = read("queue-consumers.ts");
    const uses = src.match(/[\w.]*\(?m\.body\.to\b/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u === "formatRecipientsForLedger(m.body.to" || u === "maskEmails(m.body.to").toBe(
        true
      );
    }
  });

  it("login-handler.ts: no console line or context carries a raw email", () => {
    const src = read("oauth/login-handler.ts");
    expect(src).not.toMatch(/console\.\w+\([^)]*\buser\.email\b(?!\))/);
    expect(src).not.toMatch(/context: \{ email[ ,}]/);
    expect(src).toContain("maskEmail(user.email)");
  });
});
