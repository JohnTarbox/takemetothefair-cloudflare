/**
 * OPE-851 Scope A — the round trip that IS the acceptance criterion.
 *
 * The ticket's acceptance is: *"a support email sent from an event page arrives
 * with `parsed_url` set and `match_basis` != `none`."* That is a claim about two
 * systems agreeing — the link the page renders, and the parser the inbound
 * pipeline runs over the body. Testing either alone proves nothing:
 *
 *  - testing the builder alone shows a URL is in the string, not that the
 *    pipeline finds it;
 *  - testing `extractAllUrls` alone shows it can find URLs, not that OUR body
 *    shape presents one it will find.
 *
 * So this drives the builder's output through the real `extractAllUrls` — the
 * same function the inbound-email workflow uses to populate `parsed_url`.
 *
 * The failure this guards against is specific and quiet: someone "tidies" the
 * body (drops the fence, moves the URL into the subject, wraps it in angle
 * brackets) and the link keeps working perfectly for the human while silently
 * going back to arriving unattributable — which is the entire defect.
 */
import { describe, it, expect } from "vitest";
import { buildAskAboutEventMailto, ASK_ABOUT_EVENT_ADDRESS } from "@takemetothefair/utils";
import { extractAllUrls } from "../src/email-handler.js";

const CANONICAL = "https://meetmeatthefair.com/events/litchfield-fair/2026";

/** Pull the decoded `body` back out of a mailto href, as a mail client would. */
function bodyOf(href: string): string {
  const q = href.slice(href.indexOf("?") + 1);
  const params = new URLSearchParams(q);
  return params.get("body") ?? "";
}
function subjectOf(href: string): string {
  const q = href.slice(href.indexOf("?") + 1);
  return new URLSearchParams(q).get("subject") ?? "";
}

describe("OPE-851 — the mailto body survives the inbound URL parser", () => {
  it("extractAllUrls finds the canonical event URL in the generated body", () => {
    const href = buildAskAboutEventMailto({
      eventName: "Litchfield Fair",
      year: 2026,
      canonicalUrl: CANONICAL,
    })!;
    const urls = extractAllUrls(bodyOf(href), "", 10);
    // The whole ticket in one assertion: this is what makes `parsed_url`
    // non-null when the mail lands.
    expect(urls).toContain(CANONICAL);
  });

  it("still finds it after the sender types their question above the fence", () => {
    // The realistic case. A mail client opens with the cursor at the top; the
    // sender types and sends. The fence must survive that.
    const href = buildAskAboutEventMailto({
      eventName: "Litchfield Fair",
      year: 2026,
      canonicalUrl: CANONICAL,
    })!;
    const typed = `is it ok to have a well-behaved dog on a leash ?${bodyOf(href)}`;
    expect(extractAllUrls(typed, "", 10)).toContain(CANONICAL);
  });

  it("still finds it when the client hard-wraps and re-indents the quoted tail", () => {
    const href = buildAskAboutEventMailto({
      eventName: "Litchfield Fair",
      year: 2026,
      canonicalUrl: CANONICAL,
    })!;
    const mangled = bodyOf(href).replace(/\n/g, "\r\n").replace("---", "> ---");
    expect(extractAllUrls(mangled, "", 10)).toContain(CANONICAL);
  });
});

describe("the link itself", () => {
  it("addresses the same inbox /contact publishes", () => {
    const href = buildAskAboutEventMailto({
      eventName: "Litchfield Fair",
      year: 2026,
      canonicalUrl: CANONICAL,
    })!;
    expect(href.startsWith(`mailto:${ASK_ABOUT_EVENT_ADDRESS}?`)).toBe(true);
  });

  it("names the event and year in the subject, so a human can triage it unopened", () => {
    const href = buildAskAboutEventMailto({
      eventName: "Litchfield Fair",
      year: 2026,
      canonicalUrl: CANONICAL,
    })!;
    expect(subjectOf(href)).toBe("Question about Litchfield Fair 2026");
  });

  it("omits the year when the event has no start date", () => {
    const href = buildAskAboutEventMailto({
      eventName: "Litchfield Fair",
      year: null,
      canonicalUrl: CANONICAL,
    })!;
    expect(subjectOf(href)).toBe("Question about Litchfield Fair");
  });

  it("encodes a name containing & and spaces without breaking the query string", () => {
    const href = buildAskAboutEventMailto({
      eventName: "Pizza & Pilsners Festival",
      year: 2026,
      canonicalUrl: CANONICAL,
    })!;
    // The naive version splits the subject at the ampersand and loses the body.
    expect(subjectOf(href)).toBe("Question about Pizza & Pilsners Festival 2026");
    expect(extractAllUrls(bodyOf(href), "", 10)).toContain(CANONICAL);
  });

  it("returns null rather than a link that would arrive unattributable", () => {
    // Rendering nothing beats rendering the exact defect this ticket is about.
    expect(
      buildAskAboutEventMailto({ eventName: "Litchfield Fair", year: 2026, canonicalUrl: "" })
    ).toBeNull();
    expect(
      buildAskAboutEventMailto({ eventName: "Litchfield Fair", year: 2026, canonicalUrl: "   " })
    ).toBeNull();
  });
});
