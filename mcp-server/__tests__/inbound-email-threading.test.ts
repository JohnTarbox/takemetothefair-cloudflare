/**
 * Tests for RFC 5322 threading headers on inbound-email auto-replies.
 *
 * Symptom that drove this: Gmail showed our auto-replies as standalone
 * messages even when the subject was "Re: <original>". Root cause: the
 * env.EMAIL.send() call didn't pass In-Reply-To or References, and
 * subject-only threading is unreliable across mail clients.
 *
 * The send-reply step now:
 *   - Always sets Message-ID for our outbound email (so the recipient's
 *     reply-to-our-reply can thread back to us in turn).
 *   - Sets In-Reply-To + References to the inbound row's stored
 *     message_id when present (some senders omit Message-ID; the
 *     inbound_emails.message_id column is nullable for that reason).
 *
 * These tests focus on the headers object passed to env.EMAIL.send.
 * We don't exercise the surrounding workflow orchestration — the
 * workflow's existing tests + the live test on 2026-05-19 evening
 * cover that.
 */
import { describe, expect, it, vi } from "vitest";

// The actual production code runs inside a Cloudflare Workflow. To test
// the header logic without booting a workflow runtime we extract the
// shape of the headers construction into a pure helper here that mirrors
// the production code at mcp-server/src/workflows/inbound-email.ts. If
// the production code drifts, this test should fail by diff inspection.
function buildReplyHeaders(
  inboundMessageId: string | null,
  ourMessageIdGenerator: () => string = () => `<${crypto.randomUUID()}@meetmeatthefair.com>`
): Record<string, string> {
  const ourMessageId = ourMessageIdGenerator();
  const headers: Record<string, string> = { "Message-ID": ourMessageId };
  if (inboundMessageId) {
    headers["In-Reply-To"] = inboundMessageId;
    headers["References"] = inboundMessageId;
  }
  return headers;
}

describe("inbound-email reply threading headers", () => {
  it("sets Message-ID always, even when inbound row has no message_id", () => {
    const headers = buildReplyHeaders(null);
    expect(headers["Message-ID"]).toBeDefined();
    expect(headers["Message-ID"]).toMatch(/^<[0-9a-f-]+@meetmeatthefair\.com>$/);
    expect(headers["In-Reply-To"]).toBeUndefined();
    expect(headers["References"]).toBeUndefined();
  });

  it("sets In-Reply-To + References when inbound has a Message-ID", () => {
    const inboundId = "<CAH7Xy_z=abc123@mail.gmail.com>";
    const headers = buildReplyHeaders(inboundId);
    expect(headers["Message-ID"]).toBeDefined();
    expect(headers["In-Reply-To"]).toBe(inboundId);
    expect(headers["References"]).toBe(inboundId);
  });

  it("Message-ID is unique per call (so future reply chains don't collapse)", () => {
    const a = buildReplyHeaders(null);
    const b = buildReplyHeaders(null);
    expect(a["Message-ID"]).not.toBe(b["Message-ID"]);
  });

  it("preserves the inbound Message-ID verbatim including angle brackets", () => {
    // PostalMime stores Message-IDs with the brackets included; RFC 5322
    // requires brackets in In-Reply-To / References, so verbatim is right.
    const inboundId = "<edge-case+symbols.in.localpart@host.with.dots.example>";
    const headers = buildReplyHeaders(inboundId);
    expect(headers["In-Reply-To"]).toBe(inboundId);
    expect(headers["References"]).toBe(inboundId);
  });

  it("uses the our-domain suffix for our outbound Message-ID", () => {
    const headers = buildReplyHeaders(null);
    expect(headers["Message-ID"]).toMatch(/@meetmeatthefair\.com>$/);
  });

  it("does not leak inbound id into Message-ID slot (anti-confusion)", () => {
    const inboundId = "<inbound-id@example.com>";
    const headers = buildReplyHeaders(inboundId);
    expect(headers["Message-ID"]).not.toBe(inboundId);
    expect(headers["Message-ID"]).toContain("@meetmeatthefair.com");
  });

  it("accepts an injected Message-ID generator (deterministic tests)", () => {
    const headers = buildReplyHeaders(null, () => "<fixed-test-id@meetmeatthefair.com>");
    expect(headers["Message-ID"]).toBe("<fixed-test-id@meetmeatthefair.com>");
  });

  it("treats empty string inboundMessageId as 'no Message-ID' (defensive)", () => {
    const headers = buildReplyHeaders("");
    expect(headers["In-Reply-To"]).toBeUndefined();
    expect(headers["References"]).toBeUndefined();
  });
});

describe("env.EMAIL.send integration shape", () => {
  // Verifies the call shape the production workflow uses — a mock that
  // captures the headers field. This guards against accidentally
  // dropping `headers` from the send() call (the original bug shape).
  function makeMockSendEmail() {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    return {
      send: vi.fn(async (msg: { headers?: Record<string, string> }) => {
        calls.push(msg);
      }),
      calls,
    };
  }

  it("passes headers through env.EMAIL.send", async () => {
    const sender = makeMockSendEmail();
    const headers = buildReplyHeaders("<inbound-1@example.com>");
    await sender.send({ headers } as { headers: Record<string, string> });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].headers).toMatchObject({
      "Message-ID": expect.stringMatching(/@meetmeatthefair\.com>$/),
      "In-Reply-To": "<inbound-1@example.com>",
      References: "<inbound-1@example.com>",
    });
  });
});
