/**
 * OPE-1107 — the newsletter's text/plain part, derived from HTML.
 *
 * Fixture strings are the ones the ticket quoted verbatim from the RECEIVED
 * text part of the 2026-09-21 vendor broadcast.
 */
import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "../html-to-text";
import { newsletterDigestTemplate } from "../templates";

const ISSUE = `
<h2>One takes vendors &mdash; and it is this Saturday&hellip;</h2>
<p>Sep 26 &middot; MA</p>
<p>Authors &amp; book-trade sellers</p>
<p><a href="https://meetmeatthefair.com/events/x/2026?utm_source=nl&amp;utm_medium=email">Details &rarr;</a></p>
<p>Outdoor &middot; 1 day &middot; 10am&ndash;4pm&nbsp;&nbsp; ~5 days out</p>
<ul><li>First</li><li>Second</li></ul>
<p>Write to <a href="mailto:hello@meetmeatthefair.com">hello@meetmeatthefair.com</a></p>
<p>Literal markup in copy: &lt;b&gt;stays text&lt;/b&gt;</p>
`;

describe("htmlToPlainText", () => {
  const out = htmlToPlainText(ISSUE);

  it("leaves NO entity sequences (the ticket's acceptance)", () => {
    expect(out).not.toMatch(/&[a-z#0-9]+;/i);
  });

  it("decodes the ticket's exact specimens", () => {
    expect(out).toContain("One takes vendors — and it is this Saturday…");
    expect(out).toContain("Sep 26 · MA");
    expect(out).toContain("Authors & book-trade sellers");
    expect(out).toContain("Outdoor · 1 day · 10am–4pm ~5 days out");
  });

  it("keeps a link's destination beside its label, with the href un-escaped", () => {
    expect(out).toContain(
      "Details → (https://meetmeatthefair.com/events/x/2026?utm_source=nl&utm_medium=email)"
    );
  });

  it("does not repeat an address that is its own label", () => {
    expect(out).toContain("Write to hello@meetmeatthefair.com");
    expect(out).not.toContain("(hello@meetmeatthefair.com)");
  });

  it("keeps paragraphs and list items on their own lines — not one run-on line", () => {
    expect(out.split("\n").length).toBeGreaterThan(6);
    expect(out).toContain("- First\n- Second");
  });

  it("decodes ONCE, after stripping — escaped markup in the copy survives as text", () => {
    expect(out).toContain("Literal markup in copy: <b>stays text</b>");
  });
});

describe("newsletterDigestTemplate — the text part that actually sends", () => {
  it("derives the text alternative through htmlToPlainText when none is supplied", () => {
    const tpl = newsletterDigestTemplate({
      subject: "Shows Now Open for Vendors",
      contentHtml: ISSUE,
      unsubscribeUrl: "https://meetmeatthefair.com/api/newsletter/unsubscribe?token=t",
      viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/x",
    });
    // Positive landmark first: the body really is in the text part.
    expect(tpl.text).toContain("Sep 26 · MA");
    expect(tpl.text).not.toMatch(/&[a-z#0-9]+;/i);
  });

  it("an explicit content_text still wins", () => {
    const tpl = newsletterDigestTemplate({
      subject: "s",
      contentHtml: ISSUE,
      contentText: "hand-written text",
      unsubscribeUrl: "u",
      viewInBrowserUrl: "v",
    });
    expect(tpl.text).toContain("hand-written text");
    expect(tpl.text).not.toContain("Sep 26");
  });
});
