/**
 * OPE-867 — the CAN-SPAM footer must be INSIDE the document.
 *
 * `applyCanSpamFooter` did `rendered.html + footerHtml`. `renderEmailBody`
 * returns a COMPLETE document (src/lib/email/templates.ts closes with
 * `</html>`), so the footer landed after the closing tag. Content after
 * `</html>` is undefined behaviour across mail clients — most render it, some
 * do not — so what a given recipient saw is not reconstructable from the bytes
 * we sent, and the CAN-SPAM footer is the one part that has to be there.
 *
 * ## ⚠️ Amendment H — the trap this suite is built around
 *
 * The ticket names it exactly: *"if the fixture template happens not to be a
 * full document, `rendered.html` will have no `</html>` at all and the
 * assertion passes with the bug fully present."*
 *
 * So the document fixtures below assert they ARE documents (they contain
 * `</body>` and `</html>`) before anything is asserted about placement. A
 * fixture that quietly stopped being a document would otherwise turn this whole
 * file green against the original concatenation.
 */
import { describe, it, expect } from "vitest";
import { insertBeforeBodyEnd, applyCanSpamFooter } from "../src/tools/admin-send-vendor-email";

const DOC = `<!doctype html><html><head><title>t</title></head><body><p>Hello</p></body></html>`;
const FOOTER = `<p id="footer">footer</p>`;

describe("OPE-867 — placement inside the document", () => {
  it("the fixture really is a complete document", () => {
    // The landmark. Without it every assertion below can pass vacuously.
    expect(DOC).toContain("</body>");
    expect(DOC).toContain("</html>");
  });

  it("puts the fragment immediately before </body>", () => {
    const out = insertBeforeBodyEnd(DOC, FOOTER);
    expect(out).toContain(`<p>Hello</p>${FOOTER}</body>`);
  });

  it("REGRESSION: nothing follows </html>", () => {
    const out = insertBeforeBodyEnd(DOC, FOOTER);
    expect(out.slice(out.toLowerCase().lastIndexOf("</html>") + "</html>".length)).toBe("");
  });

  it("the footer precedes the closing tags, not follows them", () => {
    const out = insertBeforeBodyEnd(DOC, FOOTER);
    expect(out.indexOf(FOOTER)).toBeLessThan(out.toLowerCase().indexOf("</body>"));
    expect(out.indexOf(FOOTER)).toBeLessThan(out.toLowerCase().indexOf("</html>"));
  });

  it("handles an uppercase </BODY>", () => {
    const out = insertBeforeBodyEnd(`<html><body>x</BODY></html>`, FOOTER);
    expect(out).toBe(`<html><body>x${FOOTER}</BODY></html>`);
  });

  it("uses the LAST </body> when markup contains the literal text earlier", () => {
    const tricky = `<html><body><code>&lt;/body&gt;</code></body></html>`;
    const out = insertBeforeBodyEnd(tricky, FOOTER);
    expect(out.slice(out.toLowerCase().lastIndexOf("</html>") + 7)).toBe("");
    expect(out).toContain(`</code>${FOOTER}</body>`);
  });
});

describe("OPE-867 — a fragment is not a document", () => {
  it("appends when there is no </body> AND no </html>", () => {
    // A free-form plain body rendered to simple markup. Appending is correct
    // here: there is no document to be outside of.
    expect(insertBeforeBodyEnd(`<p>hi</p>`, FOOTER)).toBe(`<p>hi</p>${FOOTER}`);
  });

  it("THROWS on </html> with no </body> rather than silently appending", () => {
    // ⚠️ The most important assertion in the file. A "fall back to appending"
    // branch here would restore the original defect for exactly the inputs
    // nobody tests, and it would be invisible — the send would succeed and the
    // footer would be outside the document again.
    expect(() => insertBeforeBodyEnd(`<html><p>x</p></html>`, FOOTER)).toThrow(/OPE-867/);
  });
});

/**
 * ⚠️ These exist because of a SURVIVING MUTANT.
 *
 * The block above tests `insertBeforeBodyEnd` directly. Restoring the original
 * `rendered.html + footerHtml` at the CALL SITE left all eight of those green —
 * the helper was correct and simply not called. A guard that is right and
 * unwired is indistinguishable from one that is wired, which is the whole of
 * amendment H, and the mutation is the only reason I know.
 *
 * So these drive `applyCanSpamFooter` itself.
 */
const ENV = { UNSUBSCRIBE_SECRET: "s3cret", MAILING_ADDRESS: "PO Box 1, Maine" };
const rendered = (html: string) => ({ subject: "s", text: "body text", html });

describe("OPE-867 — applyCanSpamFooter, end to end", () => {
  it("REGRESSION: the footer lands inside the document, not after </html>", async () => {
    const out = await applyCanSpamFooter(rendered(DOC), {
      recipientEmail: "a@x.com",
      reasonLine: "this is a deliverability test you triggered.",
      env: ENV,
    });
    // Landmark: a footer was actually added, so "nothing after </html>" is not
    // satisfied by having added nothing at all.
    expect(out.html).toContain("deliverability test");
    expect(out.html.slice(out.html.toLowerCase().lastIndexOf("</html>") + 7)).toBe("");
  });

  it("emits ONE consent statement and ONE unsubscribe link on a bare document", async () => {
    const out = await applyCanSpamFooter(rendered(DOC), {
      recipientEmail: "a@x.com",
      reasonLine: "you signed up for vendor show alerts.",
      env: ENV,
    });
    expect(out.html.match(/You're receiving this because/g)).toHaveLength(1);
    expect(out.html.match(/>Unsubscribe</g)).toHaveLength(1);
  });

  it("does NOT add a second consent claim to a body that already has one", async () => {
    // The two-footer case from the received 09-07 message: a newsletter, which
    // carries its own consent line and its own working unsubscribe link, passed
    // through this wrapper. Two "You're receiving this because…" statements
    // shipped, and at most one of two contradictory claims can be true.
    const newsletter = `<html><body><p>issue</p><p>You're receiving this because you subscribed to New This Week.<a href="https://meetmeatthefair.com/api/newsletter/unsubscribe?token=t">Unsubscribe</a></p></body></html>`;
    const out = await applyCanSpamFooter(rendered(newsletter), {
      recipientEmail: "a@x.com",
      reasonLine: "this is a deliverability test you triggered.",
      env: ENV,
    });
    expect(out.html.match(/You're receiving this because/g)).toHaveLength(1);
    expect(out.html.match(/>Unsubscribe</g)).toHaveLength(1);
    // The test disclosure still ships — as CONTEXT, not as a rival consent
    // claim. Losing it would be a different kind of dishonesty.
    expect(out.html).toContain("deliverability test");
    expect(out.html.slice(out.html.toLowerCase().lastIndexOf("</html>") + 7)).toBe("");
  });

  it("keeps the text and html parts saying the same thing", async () => {
    const out = await applyCanSpamFooter(rendered(DOC), {
      recipientEmail: "a@x.com",
      reasonLine: "you signed up for vendor show alerts.",
      env: ENV,
    });
    expect(out.text).toContain("you signed up for vendor show alerts.");
    expect(out.html).toContain("you signed up for vendor show alerts.");
  });
});
