/**
 * OPE-1392 (TPL-2) — the two email chokepoints strip control characters from
 * the Subject, whatever the caller built it from. Every templated subject is
 * also stripped at its source (see templates-escape-ope1392.test.ts); this is
 * the backstop for a future caller that forgets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: Array<Record<string, unknown>> = [];
const logged: Array<Record<string, unknown>> = [];

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: () => ({
    EMAIL_JOBS: { send: async (m: Record<string, unknown>) => void sent.push(m) },
  }),
  getCloudflareDb: () => null,
}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {} }) }));
vi.mock("@/lib/logger", () => ({
  logError: async (_db: unknown, e: Record<string, unknown>) => void logged.push(e),
}));

const { enqueueEmail } = await import("@/lib/queues/producers");
const { sendEmail } = await import("@/lib/email/send");
const { buildSubmissionReceivedBody } = await import("@/lib/email/submission-received");

beforeEach(() => {
  sent.length = 0;
  logged.length = 0;
});

describe("OPE-1392 — Subject control characters", () => {
  it("enqueueEmail strips CR/LF from the queued subject", async () => {
    await enqueueEmail({
      to: "a@example.com",
      subject: "[MMATF] Inquiry from Eve\r\nBcc: victim@example.com",
      html: "<p>x</p>",
      text: "x",
      source: "test",
    });
    expect(sent[0].subject).toBe("[MMATF] Inquiry from Eve Bcc: victim@example.com");
  });

  it("enqueueEmail leaves a clean subject byte-for-byte", async () => {
    const subject = "We received your event — Fryeburg Fair";
    await enqueueEmail({ to: "a@example.com", subject, html: "", text: "", source: "test" });
    expect(sent[0].subject).toBe(subject);
  });

  it("sendEmail strips CR/LF before it reaches any transport (stub branch)", async () => {
    await sendEmail(null, {
      to: "a@example.com",
      subject: "Hi\nBcc: victim@example.com",
      html: "",
      text: "",
    });
    const ctx = logged[0].context as Record<string, unknown>;
    expect(ctx.subject).toBe("Hi Bcc: victim@example.com");
  });

  it("the submission-received subject is stripped at its source", () => {
    const { subject } = buildSubmissionReceivedBody({
      toEmail: "a@example.com",
      eventName: "Fair\r\nBcc: victim@example.com",
      eventId: "0123456789",
    });
    expect(subject).toBe("We received your event — Fair Bcc: victim@example.com");
  });
});
