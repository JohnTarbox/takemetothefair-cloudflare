/**
 * OPE-763 — capture the signals that tell a spoofer from a state official.
 *
 * ── What was actually wrong ────────────────────────────────────────────────
 * Not "we discard every signal". Cloudflare Email Routing DOES attach
 * `Authentication-Results`, and `email-handler.ts` has read it since WS3e
 * (2026-06-11) to gate the trusted-sender fast-path. It condensed the header
 * to pass/fail/unknown, used it, and dropped the rest — so we were not blind
 * at the transport, we were amnesiac one line after looking.
 *
 * ── The two obligations these tests carry ──────────────────────────────────
 * 1. The capture works.
 * 2. The LIVE GATE IS UNCHANGED. Scope 5 is explicit that this ticket changes
 *    no routing and sends nothing, and the easiest way to violate that by
 *    accident is to "improve" `parseEmailAuth` while adding the richer parser
 *    beside it. So the equivalence between the two is asserted directly, over
 *    a generated cross-product rather than a hand-picked table — a table of
 *    examples proves the examples.
 */
import { describe, it, expect } from "vitest";
import {
  parseEmailAuth,
  parseEmailAuthDetail,
  collapseSenderAuth,
  type EmailAuthVerdict,
} from "../src/email-auth.js";
import { extractSenderSignals } from "../src/email-handler.js";
import type { Email } from "postal-mime";

const hdr = (v: string | null) => ({
  get: (n: string) => (n === "Authentication-Results" ? v : null),
});

/** A minimal PostalMime `Email`, overridable per case. */
function email(over: Partial<Email> = {}): Email {
  return { headers: [], headerLines: [], attachments: [], ...over } as Email;
}

describe("parseEmailAuthDetail — the record, not the gate", () => {
  it("keeps each method result rather than collapsing them", () => {
    const d = parseEmailAuthDetail(
      "mx.cloudflare.net; dkim=pass header.d=ct.gov; spf=pass smtp.mailfrom=ct.gov; dmarc=pass header.from=ct.gov"
    );
    expect(d).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", verdict: "pass" });
    expect(d.raw).toContain("ct.gov");
  });

  it("calls a mailing-list forward `partial`, not `pass`", () => {
    // spf=fail + dkim=pass is ordinary forwarded mail, and the 3-value verdict
    // has to call it "pass" so the fast-path is not broken. That is right for
    // a gate and wrong for a record: it is NOT a clean DMARC pass, and an
    // audit trail that cannot say so is not an audit trail.
    const d = parseEmailAuthDetail("mx.cloudflare.net; spf=fail; dkim=pass header.d=list.example");
    expect(d.verdict).toBe("partial");
    expect(parseEmailAuth("mx.cloudflare.net; spf=fail; dkim=pass header.d=list.example")).toBe(
      "pass"
    );
  });

  it("still calls a DMARC failure `fail` — the spoof signal is unchanged", () => {
    expect(parseEmailAuthDetail("mx.cloudflare.net; dmarc=fail header.from=ct.gov").verdict).toBe(
      "fail"
    );
  });

  it("distinguishes an absent header from an unrecognisable one", () => {
    // Both are "unknown" to the gate. For the record they differ: one means
    // the transport supplied nothing, the other means it supplied something we
    // could not read — and only the second is a bug worth chasing.
    expect(parseEmailAuthDetail(null)).toMatchObject({ raw: null, verdict: "unknown" });
    expect(parseEmailAuthDetail("mx.cloudflare.net; nonsense")).toMatchObject({
      raw: "mx.cloudflare.net; nonsense",
      verdict: "unknown",
    });
  });
});

describe("OPE-763 scope 5 — the live trusted-sender gate is untouched", () => {
  it("agrees with parseEmailAuth on every combination of method results", () => {
    // Generated, not hand-picked: 6 values x 3 methods = 216 headers, which is
    // every shape the parser can see. A hand-written table would prove the
    // table.
    const values = ["pass", "fail", "none", "neutral", "softfail", "temperror"];
    const disagreements: string[] = [];
    let checked = 0;

    for (const spf of values) {
      for (const dkim of values) {
        for (const dmarc of values) {
          const header = `mx.cloudflare.net; spf=${spf}; dkim=${dkim}; dmarc=${dmarc}`;
          const gate: EmailAuthVerdict = parseEmailAuth(header);
          const record = collapseSenderAuth(parseEmailAuthDetail(header).verdict);
          checked++;
          if (gate !== record) disagreements.push(`${header} → gate=${gate} record=${record}`);
        }
      }
    }

    // Positive landmark: if the loop ever stops running, "no disagreements" is
    // indistinguishable from "no comparisons".
    expect(checked).toBe(values.length ** 3);
    expect(
      disagreements,
      "the richer parser has diverged from the one that gates the trusted-sender fast-path — " +
        "OPE-763 is report-only and must not change routing"
    ).toEqual([]);
  });
});

describe("extractSenderSignals — the classic tells", () => {
  it("captures a display name that disagrees with the address", () => {
    // `"Jeremy Hall" <random@gmail.com>` is the whole reason the column exists.
    const s = extractSenderSignals(
      hdr("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
      email({ from: { name: "Jeremy Hall", address: "random@gmail.com" } })
    );
    expect(s.fromDisplayName).toBe("Jeremy Hall");
    expect(s.senderAuth).toBe("pass");
  });

  it("captures reply_to and return_path pointing somewhere else", () => {
    const s = extractSenderSignals(
      hdr(null),
      email({
        from: { name: "Support", address: "support@ct.gov" },
        replyTo: [{ name: "", address: "collector@elsewhere.example" }],
        returnPath: "bounce@elsewhere.example",
      })
    );
    expect(s.replyTo).toBe("collector@elsewhere.example");
    expect(s.returnPath).toBe("bounce@elsewhere.example");
    // No header supplied — and that is reported as `unknown`, not as a pass.
    expect(s.senderAuth).toBe("unknown");
  });

  it("pulls the sending host from the Received chain", () => {
    // The OPE-763 specimen: the real Jeremy Hall message came via a Microsoft
    // 365 tenant, which is checkable. We checked nothing because we kept
    // nothing.
    const s = extractSenderSignals(
      hdr(null),
      email({
        headers: [
          {
            key: "received",
            value:
              "from PH0PR09MB11424.namprd09.prod.outlook.com (2603:10b6::1) by mx.cloudflare.net",
          },
        ],
      })
    );
    expect(s.sendingHost).toBe("ph0pr09mb11424.namprd09.prod.outlook.com");
  });

  it("returns nulls rather than throwing on a message with no headers at all", () => {
    // A parse-degraded message must still produce a row. Every field null and
    // a verdict of `unknown` is a legitimate observation; an exception here
    // would lose the whole message.
    const s = extractSenderSignals(undefined, email());
    expect(s).toEqual({
      authResultsRaw: null,
      spfResult: null,
      dkimResult: null,
      dmarcResult: null,
      senderAuth: "unknown",
      fromDisplayName: null,
      replyTo: null,
      returnPath: null,
      sendingHost: null,
      // OPE-944 — NULL because this function is pure over HEADERS and never
      // sees the body, so it cannot know whether the message was a forward.
      // `withForwardSignals` supplies the verdict.
      originalSenderAddress: null,
      originalSenderAuth: null,
      originalSenderDomainAligned: null,
    });
  });

  it("does not invent a display name from the address", () => {
    // "no display name" and "a display name equal to the address" are
    // different observations, and only the first is what an address-only
    // `From:` actually carries.
    const s = extractSenderSignals(hdr(null), email({ from: { name: "", address: "a@b.com" } }));
    expect(s.fromDisplayName).toBeNull();
  });
});

/**
 * Review bounce (2026-09-23): Cloudflare writes the HELO SPF check FIRST and
 * the MAIL FROM check second. First-match recorded 232 of 243 prod rows as
 * `spf=none` / `partial` for mail whose SPF passed. This is the verbatim
 * header off one of those rows (inbound 0cb048f4, a Gmail message to ourselves).
 */
const GMAIL_TWO_SPF =
  "mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104 header.b=ZqZ/iZfx; " +
  "dmarc=pass header.from=gmail.com policy.dmarc=none; " +
  "spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-yx2-x11.google.com) smtp.helo=mail-yx2-x11.google.com; " +
  "spf=pass (mx.cloudflare.net: domain of jtarboxme@gmail.com designates 2607:f8b0:4864:41::11 as permitted sender) smtp.mailfrom=jtarboxme@gmail.com; " +
  'arc=pass smtp.remote-ip="2607:f8b0:4864:41::11"';

describe("SPF — the record reads the MAIL FROM check, not the first spf=", () => {
  it("the bounce specimen: HELO none + MAIL FROM pass records pass, and a full pass", () => {
    const d = parseEmailAuthDetail(GMAIL_TWO_SPF);
    expect(d.spf).toBe("pass");
    expect(d.verdict).toBe("pass");
  });

  it("order-independent: MAIL FROM listed first still wins", () => {
    const h =
      "mx.cloudflare.net; spf=softfail smtp.mailfrom=x@y.test; spf=pass smtp.helo=mail.y.test";
    expect(parseEmailAuthDetail(h).spf).toBe("softfail");
  });

  it("a MAIL FROM fail behind a HELO pass is recorded as the fail it is", () => {
    const h = "mx.cloudflare.net; spf=pass smtp.helo=mail.y.test; spf=fail smtp.mailfrom=x@y.test";
    const d = parseEmailAuthDetail(h);
    expect(d.spf).toBe("fail");
    expect(d.verdict).toBe("fail");
  });

  it("with no smtp.mailfrom entry, falls back to the first spf= (the old answer)", () => {
    expect(parseEmailAuthDetail("mx.cloudflare.net; spf=none smtp.helo=h.test").spf).toBe("none");
    expect(
      parseEmailAuthDetail("mx.cloudflare.net; spf=neutral smtp.helo=h.test; spf=pass").spf
    ).toBe("neutral");
  });

  it("a `;` inside a comment cannot hide the smtp.mailfrom property", () => {
    const h =
      "mx.cloudflare.net; spf=none smtp.helo=h.test; spf=pass (note; see policy) smtp.mailfrom=x@y.test";
    expect(parseEmailAuthDetail(h).spf).toBe("pass");
  });

  it("scope 5: the GATE is unchanged — it still reads the first spf= (known divergence)", () => {
    // Pinned from both sides so a later "fix" to the gate is a deliberate,
    // visible change (OPE-764's call), not a side effect of this one.
    const h = "mx.cloudflare.net; spf=pass smtp.helo=mail.y.test; spf=fail smtp.mailfrom=x@y.test";
    expect(parseEmailAuth(h)).toBe("pass");
    expect(collapseSenderAuth(parseEmailAuthDetail(h).verdict)).toBe("fail");
    // On the real specimen the two still agree, because DMARC passed.
    expect(parseEmailAuth(GMAIL_TWO_SPF)).toBe("pass");
  });
});
