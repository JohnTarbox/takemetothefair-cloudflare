/**
 * OPE-452 — we recorded our own URL as the sender's.
 *
 * Emma Welford (Paradise City Arts) replied on the "Incorrect Listing" thread
 * with three organizer-confirmed show dates. Her message contains **no URL at
 * all**. The inbound row recorded:
 *
 *     parsed_url = https://meetmeatthefair.com/promoters/paradise-city-arts-festivals
 *
 * That link appears only inside the quoted copy of OUR OWN outbound reply
 * beneath her text.
 *
 * ── What this ticket got right, and what it got wrong ─────────────────────
 *
 * The ticket read the quoted-region URL as evidence that capture had failed and
 * the body was lost. Checked against prod: `body_text` is **2,318 characters**
 * and contains all three date lines verbatim. Capture worked. Of 291 inbound
 * rows, exactly **2** captured nothing at all, and **zero** of the empty-bodied
 * rows are replies — the opposite of the ticket's "specific to replies to our
 * own outbound mail".
 *
 * What IS real is the misattribution: on any reply, the more helpful our
 * original message was, the more of our own links there are to hand to the
 * person answering us.
 */
import { describe, expect, it } from "vitest";
import { stripQuotedReply, hasQuotedReply } from "../src/email-handlers/strip-quoted-reply.js";
import { pickPrimaryUrl } from "../src/email-handler.js";

/** Emma's message, as stored in inbound_emails c35b4919. */
const EMMA = `Hi John,

Much appreciated!

The November 2026 Marlborough show will be November 20-22, 2026.
The March 2027 Marlborough show will be March 19-21, 2027.
The May 2027 Northampton show will be May 29-31, 2027.

Listing looks great and I've claimed the profile as well.

Thanks,
Emma

On Thu, Aug 13, 2026 at 7:47 PM Meet Me at the Fair <
support@meetmeatthefair.com> wrote:

> Hi Emma,
>
> Thanks for flagging this. Your promoter page is at
> https://meetmeatthefair.com/promoters/paradise-city-arts-festivals
`;

describe("the specimen", () => {
  it("keeps all three dates", () => {
    const out = stripQuotedReply(EMMA);
    expect(out).toContain("November 20-22, 2026");
    expect(out).toContain("March 19-21, 2027");
    expect(out).toContain("May 29-31, 2027");
  });

  it("drops the quoted copy of our own reply", () => {
    const out = stripQuotedReply(EMMA);
    expect(out).not.toContain("promoters/paradise-city-arts-festivals");
    expect(out).not.toContain("Thanks for flagging this");
  });

  it("yields NO url — which is the truth, she sent none", () => {
    expect(pickPrimaryUrl(stripQuotedReply(EMMA), "")).toBeNull();
  });

  it("used to pick OUR url from the quote", () => {
    // The regression, reproduced against the unstripped body.
    expect(pickPrimaryUrl(EMMA, "")).toBe(
      "https://meetmeatthefair.com/promoters/paradise-city-arts-festivals"
    );
  });
});

describe("a FORWARD must never be stripped", () => {
  // Forwards are the most common intake shape here — "John forwards an
  // organizer's email". Cutting the quoted block there would discard the
  // payload of most real submissions, which is far worse than the bug fixed.
  const FWD = `FYI

---------- Forwarded message ----------
From: Organizer <o@fair.org>
Subject: Fall Festival

Our fall festival is Sept 12-14 at https://fair.org/fall
`;

  it("leaves a forwarded message intact", () => {
    expect(stripQuotedReply(FWD)).toBe(FWD);
  });

  it("still finds the forwarded URL", () => {
    expect(pickPrimaryUrl(stripQuotedReply(FWD), "")).toBe("https://fair.org/fall");
  });

  it("does not strip a forward that also contains a reply marker below it", () => {
    const mixed = FWD + "\nOn Mon, Jan 1, 2026 at 1:00 PM X <x@y.z> wrote:\n> older\n";
    expect(stripQuotedReply(mixed)).toBe(mixed);
  });
});

describe("bottom-posting is left alone", () => {
  it("keeps everything when the sender wrote below the quote", () => {
    // Cutting here would discard the ENTIRE message — reproducing, on purpose,
    // the empty-body failure this ticket was filed about.
    const bottom = `On Thu, Aug 13, 2026 at 7:47 PM Someone <a@b.c> wrote:

> What are your dates?

Our dates are Sept 12-14. See https://fair.org/x
`;
    const out = stripQuotedReply(bottom);
    expect(out).toBe(bottom);
    expect(pickPrimaryUrl(out, "")).toBe("https://fair.org/x");
  });
});

describe("markers and non-markers", () => {
  it("handles the Outlook original-message delimiter", () => {
    const s = `Here are our dates: Sept 12-14.

-----Original Message-----
From: us
https://meetmeatthefair.com/x
`;
    expect(stripQuotedReply(s)).toContain("Sept 12-14");
    expect(stripQuotedReply(s)).not.toContain("meetmeatthefair.com/x");
  });

  it("does NOT cut on the word 'wrote:' inside prose", () => {
    // An unbounded /.*wrote:/ would eat a legitimate submission.
    const s = "Our founder wrote: a short history of the fair. Dates: Sept 12-14.";
    expect(stripQuotedReply(s)).toBe(s);
  });

  it("returns the input unchanged when there is no quote", () => {
    const s = "Fall Festival, Sept 12-14, https://fair.org/fall";
    expect(stripQuotedReply(s)).toBe(s);
    expect(hasQuotedReply(s)).toBe(false);
  });

  it.each(["", null, undefined])("passes through %p", (v) => {
    expect(stripQuotedReply(v as unknown as string)).toBe(v);
  });
});

describe("hasQuotedReply", () => {
  it("is true for the specimen and false for a forward", () => {
    expect(hasQuotedReply(EMMA)).toBe(true);
    expect(hasQuotedReply("plain body")).toBe(false);
  });
});
