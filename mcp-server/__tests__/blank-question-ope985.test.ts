/**
 * OPE-985 — the "ask about this event" mailto sent with no question is flagged
 * and NOT acknowledged; a question typed anywhere around the template is still a
 * real question.
 *
 * The four bodies below are the four times the template has ever arrived
 * (inbound_emails, all 2026-09-13), copied from the rows:
 *   6e713a8e  blank — the template untouched (the case this ticket is about)
 *   d062567b  question typed BELOW the URL
 *   4be31e4c  question typed ABOVE the fence, client signature after
 *   8760bf46  a long message below the URL
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAskAboutEventMailto, isBlankAskAboutEventBody } from "@takemetothefair/utils";
import { extractAllUrls } from "../src/email-handler.js";
import { buildReply } from "../src/email-reply-builder.js";

const NANCY_6E713A8E =
  "\n\n---\nhttps://meetmeatthefair.com/events/fall-festival-outdoor-craft-market-fayerweather/2026";
const KIMBERLEY_D062567B =
  "\n\n---\nhttps://meetmeatthefair.com/events/a-different-drummer-craft-fair-september/2026\nWill it still be held in the rain today? \n-Kimberley";
const MARLBOROUGH_4BE31E4C =
  "Hello is this still on sept 19th. I just watched a YouTube video that said it was this weekend. \n\n---\nhttps://meetmeatthefair.com/events/marlborough-gun-show-september/2026\n\nSent from my Galaxy";
const DOUGLAS_8760BF46 =
  "\n\n---\nhttps://meetmeatthefair.com/events/pttf-holiday-craft-fair/2026\nI sent an application to be a vendor at your upcoming craft fair at Thorntons Ferry Elementary School, Merrimack N.H.";

describe("OPE-985 — isBlankAskAboutEventBody on the four real bodies", () => {
  it("ACCEPTANCE: the untouched template (6e713a8e) is blank", () => {
    expect(isBlankAskAboutEventBody(NANCY_6E713A8E)).toBe(true);
  });

  it("ACCEPTANCE: prose below the URL is a real question — captured, not stripped", () => {
    expect(isBlankAskAboutEventBody(KIMBERLEY_D062567B)).toBe(false);
    expect(isBlankAskAboutEventBody(DOUGLAS_8760BF46)).toBe(false);
  });

  it("prose above the fence is a real question, even with a client signature after", () => {
    expect(isBlankAskAboutEventBody(MARLBOROUGH_4BE31E4C)).toBe(false);
  });
});

describe("OPE-985 — the detector's edges", () => {
  const T = "\n\n---\nhttps://meetmeatthefair.com/events/litchfield-fair/2026";

  it("a client-added signature alone does not make it a question", () => {
    expect(isBlankAskAboutEventBody(`${T}\n\nSent from my iPhone`)).toBe(true);
    expect(isBlankAskAboutEventBody(`${T}\n\nGet Outlook for iOS`)).toBe(true);
  });

  it("CRLF line endings and a client that quotes the tail (`> ---`) still read as the template", () => {
    expect(isBlankAskAboutEventBody(T.replace(/\n/g, "\r\n").replace("---", "> ---"))).toBe(true);
  });

  it("one word of prose is a question", () => {
    expect(isBlankAskAboutEventBody(`Parking?${T}`)).toBe(false);
    expect(isBlankAskAboutEventBody(`${T}\nparking`)).toBe(false);
  });

  it("not our template: a foreign URL, no fence, or an empty body", () => {
    expect(isBlankAskAboutEventBody("\n\n---\nhttps://example.com/events/x")).toBe(false);
    expect(isBlankAskAboutEventBody("https://meetmeatthefair.com/events/x/2026")).toBe(false);
    expect(isBlankAskAboutEventBody("")).toBe(false);
    expect(isBlankAskAboutEventBody(null)).toBe(false);
  });
});

describe("OPE-985 — the builder and the detector agree (one source)", () => {
  const bodyOf = (href: string) =>
    new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("body") ?? "";
  const subjectOf = (href: string) =>
    new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("subject") ?? "";
  const url = "https://meetmeatthefair.com/events/pttf-holiday-craft-fair/2026";

  it("the body the page renders, sent untouched, is detected as blank — and still carries parsed_url", () => {
    const body = bodyOf(
      buildAskAboutEventMailto({ eventName: "X", year: 2026, canonicalUrl: url })!
    );
    expect(isBlankAskAboutEventBody(body)).toBe(true);
    expect(extractAllUrls(body, "", 10)).toContain(url); // OPE-977 still resolves it
  });

  it("scope 5: a name already ending in its year is not doubled in the subject", () => {
    expect(
      subjectOf(
        buildAskAboutEventMailto({
          eventName: "PTTF Holiday Craft Fair 2026",
          year: 2026,
          canonicalUrl: url,
        })!
      )
    ).toBe("Question about PTTF Holiday Craft Fair 2026");
    // Positive landmark: a name WITHOUT the year still gets it.
    expect(
      subjectOf(
        buildAskAboutEventMailto({ eventName: "Litchfield Fair", year: 2026, canonicalUrl: url })!
      )
    ).toBe("Question about Litchfield Fair 2026");
    // "2026" inside a longer number is not the year suffix.
    expect(
      subjectOf(
        buildAskAboutEventMailto({ eventName: "Expo 12026", year: 2026, canonicalUrl: url })!
      )
    ).toBe("Question about Expo 12026 2026");
  });
});

describe("OPE-985 — the workflow suppresses the acknowledgement (source-level, like OPE-766)", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
    "utf8"
  );
  const at = (needle: string) => {
    const i = SRC.indexOf(needle);
    expect(i, `"${needle}" not found — this guard is inert, not passing`).toBeGreaterThan(-1);
    return i;
  };

  it("detects before dispatch and before send-reply", () => {
    const detect = at('"blank-question/detect"');
    expect(at('"dispatch"')).toBeGreaterThan(detect);
    expect(at('"send-reply"')).toBeGreaterThan(detect);
  });

  it("the blank branch is FIRST in the result chain, and sends nothing, skips the 7-day pause, flags for review", () => {
    const branch = at("if (blankQuestion) {");
    expect(at("} else if (unrouted?.ask) {")).toBeGreaterThan(branch);
    const block = SRC.slice(branch, SRC.indexOf("} else if (unrouted?.ask) {"));
    expect(block).toContain('replyKind: "blank-question"');
    expect(block).toContain("suppressReply: true");
    expect(block).toContain("skipAdminDecision: true");
    const detectBlock = SRC.slice(at('"blank-question/detect"'), branch);
    expect(detectBlock).toContain('flaggedForReview: 1, extractFailReason: "blank-question"');
    expect(detectBlock).toContain("isBlankAskAboutEventBody(");
  });

  it("the send step is skipped for a suppressed reply (the guard this relies on)", () => {
    expect(SRC).toContain("if (result.replyKind !== null && !result.suppressReply) {");
  });

  it("blank-question has no copy: rendering it throws instead of inventing a reply", () => {
    expect(() => buildReply("blank-question", "a@b.c", {})).toThrow(/never sent/);
  });
});
