/**
 * OPE-261 — the operator alert channel must be able to reach MORE THAN ONE
 * address.
 *
 * Context worth keeping: `ALERT_EMAIL_TECHNICAL` pointed at
 * `alert@meetmeatthefair.com`, which routes back into our own inbound-email
 * worker (`audit-noop`). Every stale-red digest was delivered — status `sent`
 * in the ledger — to a robot, so no human ever saw one.
 *
 * The digest travels main app → EMAIL_JOBS → THIS consumer's `sendViaCfEmail`,
 * i.e. Cloudflare Email Sending, NOT Resend. The binding's builder overload
 * types `to` as `string | EmailAddress | (string | EmailAddress)[]` — handed a
 * comma-separated STRING it is one malformed address. So these assert on what
 * the binding actually receives, not merely on the splitting helper.
 */
import { describe, it, expect, vi } from "vitest";
import { sendViaCfEmail } from "../src/queue-consumers.js";

type SentArgs = { from: string; to: unknown; subject: string };

function fakeBinding(sent: SentArgs[]) {
  return {
    send: vi.fn(async (args: SentArgs) => {
      sent.push(args);
      return { messageId: "cf-msg-1" };
    }),
  } as unknown as SendEmail;
}

const job = (to: string) => ({
  to,
  subject: "⚠️ 7 dashboard signals stuck red",
  html: "<p>digest</p>",
  text: "digest",
  source: "cpi.stale-red",
});

describe("sendViaCfEmail — multi-recipient operator alerts (OPE-261)", () => {
  it("hands the binding an ARRAY when ALERT_EMAIL_TECHNICAL names two operators", async () => {
    const sent: SentArgs[] = [];
    const res = await sendViaCfEmail(
      job("alert@meetmeatthefair.com,jtarboxme@gmail.com"),
      fakeBinding(sent)
    );

    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["alert@meetmeatthefair.com", "jtarboxme@gmail.com"]);
    // The bug this replaces: one string containing a comma.
    expect(typeof sent[0].to).not.toBe("string");
  });

  it("keeps alert@ first so the inbound-worker audit archive stays primary", async () => {
    const sent: SentArgs[] = [];
    await sendViaCfEmail(
      job(" alert@meetmeatthefair.com , jtarboxme@gmail.com "),
      fakeBinding(sent)
    );
    expect((sent[0].to as string[])[0]).toBe("alert@meetmeatthefair.com");
  });

  it("is a no-op change for ordinary single-recipient transactional mail", async () => {
    const sent: SentArgs[] = [];
    await sendViaCfEmail(job("vendor@example.com"), fakeBinding(sent));
    expect(sent[0].to).toEqual(["vendor@example.com"]);
  });

  it("refuses rather than calling the binding when `to` is empty", async () => {
    const sent: SentArgs[] = [];
    const binding = fakeBinding(sent);
    const res = await sendViaCfEmail(job("  ,  "), binding);

    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
    // A refused send returns an error the caller ledgers + retries, rather
    // than silently "succeeding" with no recipient.
    if (!res.ok) expect(res.error).toContain("no valid recipient");
  });
});
