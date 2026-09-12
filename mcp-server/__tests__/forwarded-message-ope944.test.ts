/**
 * OPE-944 — forwarded-message recovery and original-sender labelling.
 *
 * The specimen throughout is inbound `9fc287ef`: Carolyn forwarded the Town of
 * New Gloucester's vendor packet, and the row records `dkim=pass
 * header.d=gmail.com` / `sender_auth: partial` — true of Carolyn's Gmail, and
 * read by a human as if it vouched for the Town.
 */
import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import {
  analyzeForward,
  claimedInlineForwardSender,
  isRfc822Attachment,
  looksLikeInlineForward,
} from "../src/email-handlers/forwarded-message.js";
import { isSignatureFurniture } from "../src/email-handler.js";

const CRLF = "\r\n";

const INNER_BODY = "NEW GLOUCESTER COMMUNITY FAIR\r\nabout 70 vendors\r\n9:00 AM-3:00 PM\r\n";

/** The organizer's own message, with a roster PDF attached. */
function innerMessage(withDkim = true): string {
  return [
    "From: Sarah Rodriguez <recdirector@newgloucester.com>",
    "To: Sarah Rodriguez <recdirector@newgloucester.com>",
    "Subject: New Gloucester Community Fair - Information",
    "Date: Thu, 10 Sep 2026 12:04:00 -0400",
    ...(withDkim
      ? [
          "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=newgloucester.com;" +
            " s=sel1; h=from:subject; bh=AAAA; b=BBBB",
        ]
      : []),
    'Content-Type: multipart/mixed; boundary="IN"',
    "",
    "--IN",
    "Content-Type: text/plain",
    "",
    INNER_BODY,
    "--IN",
    'Content-Type: application/pdf; name="Vendorlist.pdf"',
    'Content-Disposition: attachment; filename="Vendorlist.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.7 the 78-space booth list").toString("base64"),
    "--IN--",
    "",
  ].join(CRLF);
}

/** Carolyn's forward. `asAttachment` picks the Gmail "Forward as attachment" shape. */
function outerMessage(asAttachment: boolean, withDkim = true): string {
  return [
    "From: Carolyn Smith <shpandabear10@gmail.com>",
    "To: submit@meetmeatthefair.com",
    "Subject: Fwd: New Gloucester Community Fair - Information",
    'Content-Type: multipart/mixed; boundary="OUT"',
    "",
    "--OUT",
    "Content-Type: text/plain",
    "",
    "Forwarding this along.",
    "--OUT",
    "Content-Type: message/rfc822",
    ...(asAttachment ? ['Content-Disposition: attachment; filename="fwd.eml"'] : []),
    "",
    innerMessage(withDkim),
    "--OUT--",
    "",
  ].join(CRLF);
}

describe("OPE-944 — what postal-mime does on its own (the MEASURED baseline)", () => {
  // These are not tests of our code. They pin the library behaviour the whole
  // design rests on, so a postal-mime upgrade that changes it fails HERE with a
  // clear name rather than silently altering what reaches the extractor.

  it("Gmail 'Forward as attachment': the nested PDF is NOT hoisted and the body is NOT merged", async () => {
    const p = await PostalMime.parse(outerMessage(true));
    expect(p.attachments.map((a) => a.mimeType)).toEqual(["message/rfc822"]);
    expect(p.text ?? "").not.toMatch(/about 70 vendors/);
  });

  it("no Content-Disposition: postal-mime ALREADY inlines it — body merged, PDF hoisted", async () => {
    // ⚠️ This CORRECTS the filing ticket, which said nested content is lost for
    // message/rfc822 generally. It is lost only for the attachment-disposition
    // shape; this one already works today.
    const p = await PostalMime.parse(outerMessage(false));
    expect(p.attachments.map((a) => a.mimeType)).toEqual(["application/pdf"]);
    expect(p.text ?? "").toMatch(/about 70 vendors/);
  });
});

describe("OPE-944 — recovering the attached message", () => {
  it("finds the rfc822 part, parses it, and surfaces the nested PDF", async () => {
    const p = await PostalMime.parse(outerMessage(true));
    const r = await analyzeForward({ attachments: p.attachments, bodyText: p.text });

    expect(r.kind).toBe("rfc822_attachment");
    expect(r.nested).not.toBeNull();
    expect(r.nested!.text).toMatch(/about 70 vendors/);
    expect(r.nested!.subject).toBe("New Gloucester Community Fair - Information");
    expect(r.nested!.attachments.map((a) => a.filename)).toEqual(["Vendorlist.pdf"]);
  });

  it("ACCEPTANCE: the attachment shape recovers what the inline shape already gives", async () => {
    // The ticket's first acceptance criterion, as a property rather than two
    // hand-copied expectations: whatever the inline forward yields, the
    // attachment forward must yield too.
    const inline = await PostalMime.parse(outerMessage(false));
    const attached = await PostalMime.parse(outerMessage(true));
    const r = await analyzeForward({ attachments: attached.attachments, bodyText: attached.text });

    const recoveredText = `${attached.text ?? ""}\n\n${r.nested?.text ?? ""}`;
    const recoveredAttachments = [
      ...attached.attachments.filter((a) => !isRfc822Attachment(a)),
      ...(r.nested?.attachments ?? []),
    ];

    for (const line of ["NEW GLOUCESTER COMMUNITY FAIR", "about 70 vendors", "9:00 AM-3:00 PM"]) {
      expect(inline.text ?? "").toContain(line);
      expect(recoveredText).toContain(line);
    }
    expect(recoveredAttachments.map((a) => a.filename)).toEqual(
      inline.attachments.map((a) => a.filename)
    );
  });

  it("keeps the .eml bytes UNMODIFIED — a re-encode would break the signature", async () => {
    const p = await PostalMime.parse(outerMessage(true));
    const r = await analyzeForward({ attachments: p.attachments, bodyText: p.text });
    // The raw must still contain the original signature and the base64 PDF
    // exactly; anything that round-tripped through a serializer would not.
    expect(r.nested!.raw).toContain("DKIM-Signature: v=1;");
    expect(r.nested!.raw).toContain(
      Buffer.from("%PDF-1.7 the 78-space booth list").toString("base64")
    );
  });

  it("reports key_unavailable — not no_signature — when no resolver is supplied", async () => {
    // "We could not check" and "there was nothing to check" are different
    // facts, and only one of them is about the message.
    const p = await PostalMime.parse(outerMessage(true));
    const r = await analyzeForward({ attachments: p.attachments, bodyText: p.text });
    expect(r.originalSenderAuth).toBe("key_unavailable");
  });

  it("a nested message with NO signature reads no_signature", async () => {
    const p = await PostalMime.parse(outerMessage(true, false));
    const r = await analyzeForward({
      attachments: p.attachments,
      bodyText: p.text,
      resolveTxt: async () => [],
    });
    expect(r.originalSenderAuth).toBe("no_signature");
    expect(r.originalSenderAddress).toBe("recdirector@newgloucester.com");
  });

  it("does not report alignment for a signature that FAILED", async () => {
    // A `d=` on a failed signature says nothing about who sent the message;
    // reporting its alignment would dress an unverified claim as a finding.
    const p = await PostalMime.parse(outerMessage(true));
    const r = await analyzeForward({
      attachments: p.attachments,
      bodyText: p.text,
      resolveTxt: async () => ["v=DKIM1; k=rsa; p=bogus"],
    });
    expect(r.originalSenderAuth).not.toBe("verified");
    expect(r.originalSenderDomainAligned).toBeNull();
  });
});

describe("OPE-944 — the inline forward is labelled honestly", () => {
  it("ACCEPTANCE: the New Gloucester inline forward reads unverifiable_inline_forward", async () => {
    // The real stored body of 9fc287ef, opening lines verbatim.
    const bodyText = [
      "---------- Forwarded message ---------",
      "From: Sarah Rodriguez <recdirector@newgloucester.com>",
      "Date: Thu, Sep 10, 2026 at 12:04 PM",
      "Subject: New Gloucester Community Fair - Information",
      "To: Sarah Rodriguez <recdirector@newgloucester.com>",
      "",
      "*NEW GLOUCESTER COMMUNITY FAIR*",
      "about 70 vendors, crafters, community groups",
    ].join("\n");

    const r = await analyzeForward({ attachments: [], bodyText });
    expect(r.kind).toBe("inline_forward");
    expect(r.originalSenderAuth).toBe("unverifiable_inline_forward");
    // Captured for the audit trail, explicitly as a CLAIM and not as evidence.
    expect(r.originalSenderAddress).toBe("recdirector@newgloucester.com");
    expect(r.originalSenderDomainAligned).toBeNull();
  });

  it("ACCEPTANCE: a non-forward reads not_forwarded", async () => {
    const r = await analyzeForward({
      attachments: [],
      bodyText: "Hi, please add our fair on June 3rd. Thanks!",
    });
    expect(r.kind).toBe("not_forwarded");
    expect(r.originalSenderAuth).toBe("not_forwarded");
    expect(r.originalSenderAddress).toBeNull();
  });

  it("an inline forward with no readable From: still reads unverifiable, with a null address", async () => {
    const r = await analyzeForward({
      attachments: [],
      bodyText: "Begin forwarded message:\n\nSubject: something\n\nbody",
    });
    expect(r.originalSenderAuth).toBe("unverifiable_inline_forward");
    expect(r.originalSenderAddress).toBeNull();
  });

  it("claimedInlineForwardSender ignores a From: far below the delimiter", () => {
    // A reply chain quoted further down must not be mistaken for the forwarded
    // sender — the address we record is labelled unverifiable, but it should
    // still be the RIGHT unverifiable address.
    const body = [
      "---------- Forwarded message ---------",
      "Subject: s",
      "",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "From: wrong@example.com",
    ].join("\n");
    expect(claimedInlineForwardSender(body)).toBeNull();
  });

  it("looksLikeInlineForward matches both Gmail and Apple delimiters", () => {
    expect(looksLikeInlineForward("---------- Forwarded message ---------")).toBe(true);
    expect(looksLikeInlineForward("Begin forwarded message:")).toBe(true);
    expect(looksLikeInlineForward("I forwarded this to my colleague")).toBe(false);
    expect(looksLikeInlineForward(null)).toBe(false);
  });
});

describe("OPE-944 — which parts count as a forwarded message", () => {
  it("accepts message/rfc822", () => {
    expect(isRfc822Attachment({ filename: "fwd.eml", mimeType: "message/rfc822" })).toBe(true);
    expect(isRfc822Attachment({ filename: null, mimeType: "MESSAGE/RFC822" })).toBe(true);
  });

  it("accepts a .eml sent as application/octet-stream, which several clients do", () => {
    expect(
      isRfc822Attachment({ filename: "packet.eml", mimeType: "application/octet-stream" })
    ).toBe(true);
  });

  it("does NOT accept a non-.eml octet-stream, or the media we already handled", () => {
    expect(isRfc822Attachment({ filename: "x.zip", mimeType: "application/octet-stream" })).toBe(
      false
    );
    expect(isRfc822Attachment({ filename: "poster.pdf", mimeType: "application/pdf" })).toBe(false);
    expect(isRfc822Attachment({ filename: "logo.png", mimeType: "image/png" })).toBe(false);
  });

  it("a forwarded message is never classified as signature furniture", () => {
    // Furniture is deprioritised behind payload. An .eml landing in that quota
    // would be a silent partial regression of this whole fix.
    expect(
      isSignatureFurniture(
        { mimeType: "message/rfc822", contentId: "abc", disposition: "inline", related: true },
        500
      )
    ).toBe(false);
  });
});

describe("OPE-944 — the .eml survives as OCTETS, not as text", () => {
  /**
   * The guard this pins: `toText` decodes the forwarded message as Latin-1, not
   * UTF-8. DKIM canonicalizes OCTETS, so a UTF-8 decode replaces every invalid
   * sequence with U+FFFD and silently changes the bytes the body hash is
   * computed over — turning a genuine organizer signature into `failed`.
   *
   * ⚠️ This test exists because the mutation was NOT caught. Flipping the
   * decoder to UTF-8 left the whole suite green, since every other fixture here
   * is pure ASCII and the two decodings agree byte-for-byte on ASCII. A comment
   * asserting the decoder matters, with no test that can tell, is exactly the
   * control that is indistinguishable from being absent.
   */
  it("a high byte in the forwarded message round-trips unchanged (UTF-8 would mangle it)", async () => {
    // 0xE9 alone is "é" in Latin-1 and an INVALID UTF-8 sequence — the cheapest
    // byte that distinguishes the two decodings.
    const innerBytes = Buffer.concat([
      Buffer.from("From: org@example.com\r\nSubject: caf", "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("\r\n\r\nbody\r\n", "latin1"),
    ]);
    const raw = Buffer.concat([
      Buffer.from(
        [
          "From: fwd@example.com",
          "To: submit@meetmeatthefair.com",
          'Content-Type: multipart/mixed; boundary="OUT"',
          "",
          "--OUT",
          "Content-Type: message/rfc822",
          'Content-Disposition: attachment; filename="fwd.eml"',
          "",
          "",
        ].join(CRLF),
        "latin1"
      ),
      innerBytes,
      Buffer.from(`${CRLF}--OUT--${CRLF}`, "latin1"),
    ]);

    const p = await PostalMime.parse(raw);
    const r = await analyzeForward({ attachments: p.attachments, bodyText: p.text });

    expect(r.nested).not.toBeNull();
    const idx = r.nested!.raw.indexOf("caf");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The decisive assertion: the byte is still 0xE9, not U+FFFD (65533).
    expect(r.nested!.raw.charCodeAt(idx + 3)).toBe(0xe9);
    expect(r.nested!.raw).not.toContain("�");
  });
});
