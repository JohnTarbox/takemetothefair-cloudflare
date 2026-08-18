/**
 * OPE-466 — the unsubscribe handler removed a subscriber on the classifier's
 * verdict alone, and our own CAN-SPAM footer reads as an unsubscribe request.
 *
 * The two fixtures below are the REAL probe bodies from the OPE-455
 * investigation (`inbound_emails d72bf59b…` and `085fcb5d…`), the only two rows
 * ever classified `unsubscribe`. Nothing in either was written by a human
 * asking to leave; the word arrived in the footer we appended ourselves.
 */
import { describe, expect, it } from "vitest";
import {
  findUnsubscribeRequest,
  senderAuthoredText,
  stripSignatureBlock,
} from "../src/email-handlers/sender-authored-text.js";

/** Exactly what `send_test_email` appends to every outbound message. */
const OUR_FOOTER = `

--
You're receiving this because this is a deliverability test you triggered from Meet Me at the Fair.
Unsubscribe: https://meetmeatthefair.com/unsubscribe/YWxlcnRAbWVldG1l/e262940539a32e4b
Meet Me at the Fair · 18 Main St, Phillips, ME 04966`;

describe("the two probe bodies that were classified `unsubscribe`", () => {
  it("finds no request in the QP round-trip fixture", () => {
    const body = `QP1 ?v=cancel
QP2 ?id=12345
QP3 ?ref=beef99
QP4 ?utm_source=facebook
OK1 ?v=correct
LIT =3D
END${OUR_FOOTER}`;
    expect(findUnsubscribeRequest(body)).toBeNull();
  });

  it("finds no request in the A/B fixture", () => {
    const body = `A1 https://meetmeatthefair.com/feedback/tok?v=cancel
A2 https://meetmeatthefair.com/feedback/tok?id=12345
A5 CONTROL ?v=correct
A6 LITERAL =3D
A-END${OUR_FOOTER}`;
    expect(findUnsubscribeRequest(body)).toBeNull();
  });

  it("still finds no request when the body is ONLY our footer", () => {
    // The degenerate case the whole ticket is about: an empty forward, a mobile
    // reply that lost its body. There is no sender text at all, so there is
    // certainly no request in it.
    expect(findUnsubscribeRequest(OUR_FOOTER)).toBeNull();
  });
});

describe("a real request still works — the fix must not break the feature", () => {
  it("matches a bare one-word reply", () => {
    expect(findUnsubscribeRequest("UNSUBSCRIBE")).toBe("UNSUBSCRIBE");
  });

  it("matches a sentence, even with our footer underneath", () => {
    expect(findUnsubscribeRequest(`Please remove me from your list.${OUR_FOOTER}`)).toBe(
      "remove me"
    );
  });

  it("matches the carrier convention", () => {
    expect(findUnsubscribeRequest("STOP")).toBeTruthy();
  });

  it("matches 'take me off'", () => {
    expect(findUnsubscribeRequest("Hi — please take me off this mailing list, thanks.")).toBe(
      "take me off"
    );
  });

  it("matches opt-out in either spelling", () => {
    expect(findUnsubscribeRequest("I want to opt out")).toBeTruthy();
    expect(findUnsubscribeRequest("I want to opt-out")).toBeTruthy();
  });

  it("returns the phrase, not just a boolean, so a removal is answerable", () => {
    // Scope 3: "a removal nobody can explain is not answerable when disputed."
    expect(findUnsubscribeRequest("please unsubscribe me")).toBe("unsubscribe");
  });
});

describe("what must NOT count as a request", () => {
  it("ignores 'stop by our booth'", () => {
    // `stop` is only the carrier convention when it stands alone. This inbox is
    // full of fairground prose.
    expect(findUnsubscribeRequest("Come stop by our booth at the fair!")).toBeNull();
  });

  it("ignores an unsubscribe word that only appears in a QUOTED reply", () => {
    const body = `Thanks, that's the right date.

On Thu, Aug 13, 2026 at 7:47 PM Meet Me at the Fair <hello@meetmeatthefair.com> wrote:
> Thanks for your submission! If you'd rather not hear from us,
> Unsubscribe: https://meetmeatthefair.com/unsubscribe/abc`;
    expect(findUnsubscribeRequest(body)).toBeNull();
  });

  it("does not fire on ordinary submission prose", () => {
    expect(
      findUnsubscribeRequest("Please add our craft fair on November 7 at the Elks Lodge.")
    ).toBeNull();
  });
});

describe("stripSignatureBlock fails safe", () => {
  it("keeps the body when there is no delimiter", () => {
    expect(stripSignatureBlock("just a message")).toBe("just a message");
  });

  it("cuts even when little remains — nobody bottom-posts below their own sig", () => {
    // This is where it deliberately differs from stripQuotedReply, whose
    // bottom-post guard exists because people DO write below a quote. A
    // signature delimiter means "nothing after this is the message", so a
    // short remainder is the answer, not a symptom of a bad cut.
    expect(stripSignatureBlock(`ok\n--\n${"x".repeat(50)}`)).toBe("ok");
  });

  it("yields nothing when the body IS the footer", () => {
    // The degenerate case the ticket is about — an empty forward, a mobile
    // reply that lost its body. Falling back to the whole footer here is
    // exactly how a classifier came to read our own words as the sender's.
    expect(stripSignatureBlock(OUR_FOOTER).length).toBe(0);
  });

  it("cuts at the LAST delimiter, since a quoted chain can carry several", () => {
    const body = `My actual message is here and it is long enough.
--
first sig
--
second sig`;
    expect(stripSignatureBlock(body)).toBe(
      "My actual message is here and it is long enough.\n--\nfirst sig"
    );
  });

  it("does not treat a prose dash run as a delimiter", () => {
    const body = "We run the fair -- rain or shine -- every November.";
    expect(stripSignatureBlock(body)).toBe(body);
  });

  it("handles the trailing-space form clients emit", () => {
    expect(stripSignatureBlock("A message long enough to survive.\n-- \nSig line")).toBe(
      "A message long enough to survive."
    );
  });

  it("passes empty input straight through", () => {
    expect(stripSignatureBlock("")).toBe("");
    expect(senderAuthoredText(null)).toBe("");
    expect(senderAuthoredText(undefined)).toBe("");
  });
});

describe("senderAuthoredText composes both strippers", () => {
  it("removes a quoted transcript AND a trailing footer", () => {
    const body = `Yes, November 7 is right.

On Thu, Aug 13, 2026 at 7:47 PM Someone <a@b.com> wrote:
> anything at all${OUR_FOOTER}`;
    expect(senderAuthoredText(body)).toBe("Yes, November 7 is right.");
  });
});
