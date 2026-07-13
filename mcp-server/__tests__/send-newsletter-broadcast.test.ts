/**
 * OPE-190 — send_newsletter_broadcast STOP-gate + forwarding.
 *
 * The tool is a thin forwarder to POST /api/admin/newsletter/send. These tests
 * pin the belt-and-suspenders STOP-gate enforced IN the tool before any HTTP
 * call: a real broadcast (no test_recipient, no preview_only) is refused unless
 * require_human_confirmation === "GO"; test/preview/GO paths forward with
 * X-Internal-Key. No real endpoint is hit — fetch is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer } from "./setup-db.js";
import { registerSendNewsletterBroadcastTool } from "../src/tools/admin-send-newsletter-broadcast.js";

const ADMIN_AUTH = { role: "ADMIN", userId: "admin-1" } as never;
const ENV = { MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "sekret" };

type FetchCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: FetchCall[] = [];
let originalFetch: typeof globalThis.fetch;

function stubFetch(response: Record<string, unknown>, status = 200) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
}

function toolResult(res: unknown): {
  text: string;
  json: Record<string, unknown>;
  isError?: boolean;
} {
  const r = res as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0].text;
  return { text, json: JSON.parse(text) as Record<string, unknown>, isError: r.isError };
}

function server() {
  const s = new CapturingMcpServer();
  registerSendNewsletterBroadcastTool(s as never, {} as never, ADMIN_AUTH, ENV);
  return s;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("send_newsletter_broadcast — STOP-gate (OPE-190)", () => {
  it("refuses a real broadcast without require_human_confirmation:'GO' — no HTTP call", async () => {
    const s = server();
    const res = toolResult(
      await s.invoke("send_newsletter_broadcast", { subject: "Hi", content_html: "<p>x</p>" })
    );
    expect(res.json.stopped).toBe(true);
    expect(res.json.reason).toBe("stop_gate");
    expect(calls).toHaveLength(0);
  });

  it("refuses when require_human_confirmation is the wrong string", async () => {
    const s = server();
    const res = toolResult(
      await s.invoke("send_newsletter_broadcast", {
        subject: "Hi",
        content_html: "<p>x</p>",
        require_human_confirmation: "go", // wrong case
      })
    );
    expect(res.json.stopped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("forwards a real broadcast when require_human_confirmation:'GO'", async () => {
    stubFetch({ success: true, mode: "broadcast", recipients: 5, issue_slug: "hi-2026-07-13" });
    const s = server();
    const res = toolResult(
      await s.invoke("send_newsletter_broadcast", {
        subject: "Hi",
        content_html: "<p>x</p>",
        require_human_confirmation: "GO",
      })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://app.test/api/admin/newsletter/send");
    expect(calls[0].headers["x-internal-key"]).toBe("sekret");
    // The confirmation token is a tool-side gate — it is NOT forwarded to the endpoint.
    expect(calls[0].body.require_human_confirmation).toBeUndefined();
    expect(calls[0].body.preview_only).toBeUndefined();
    expect(res.json.mode).toBe("broadcast");
    expect(res.json.recipients).toBe(5);
  });

  it("allows a test send unattended (no confirmation needed) and forwards test_recipient", async () => {
    stubFetch({ success: true, mode: "test", recipients: 1 });
    const s = server();
    await s.invoke("send_newsletter_broadcast", {
      subject: "Hi",
      content_html: "<p>x</p>",
      test_recipient: "me@x.com",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.test_recipient).toBe("me@x.com");
  });

  it("allows a preview unattended and forwards preview_only", async () => {
    stubFetch({ success: true, preview: true, recipient_count: 5, recipients: [] });
    const s = server();
    const res = toolResult(
      await s.invoke("send_newsletter_broadcast", {
        subject: "Hi",
        content_html: "<p>x</p>",
        preview_only: true,
      })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body.preview_only).toBe(true);
    expect(res.json.mode).toBe("preview");
  });

  it("surfaces an endpoint error (e.g. broadcast_disabled) as isError", async () => {
    stubFetch({ error: "broadcast_disabled", message: "flag off" }, 409);
    const s = server();
    const res = toolResult(
      await s.invoke("send_newsletter_broadcast", {
        subject: "Hi",
        content_html: "<p>x</p>",
        require_human_confirmation: "GO",
      })
    );
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("broadcast_disabled");
    expect(res.json.http_status).toBe(409);
  });
});
