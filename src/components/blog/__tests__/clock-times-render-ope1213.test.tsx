/**
 * OPE-1213 — every `H:MM` clock time on the blog lost its minutes.
 *
 * remark-directive reads the `:30` in "5:30 p.m." as a text directive named
 * "30"; unregistered, react-markdown's unknown-node handler rendered it as an
 * empty `<div>`. Live: "caroling starts at 5<div></div> p.m." on 28 posts.
 *
 * Rendered through the REAL `MarkdownContent` (same plugin chain as the page),
 * asserting on the served HTML — the symptom lives in the output, not the tree.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../markdown-content";

const html = (md: string) => renderToStaticMarkup(<MarkdownContent content={md} />);

describe("clock times render verbatim", () => {
  it.each([
    ["caroling starts at 5:30 p.m. and the tree is lit at 6 p.m.", "5:30 p.m."],
    ["**Sunday, Dec. 6, 12:30–1 p.m.** — Santa arrives by lobster boat", "12:30–1 p.m."],
    ["Open 2:00 to 8:00 pm daily.", "2:00 to 8:00 pm"],
    ["Arrival windows: 5:30–5:45 PM.", "5:30–5:45 PM"],
    ["Mix at a 1:1 ratio.", "1:1 ratio"],
    ["Arriving early (around 6:30am) is best.", "6:30am"],
  ])("%s", (md, expected) => {
    const out = html(md);
    expect(out).toContain(expected);
    expect(out).not.toMatch(/[0-9]<div><\/div>/);
  });

  it("a label/attribute-bearing prose directive is kept verbatim too", () => {
    expect(html("See note:tip[this]{x=1} here.")).toContain(":tip[this]{x=1}");
  });

  it("registered embeds still render as components (the allowlist still works)", () => {
    const out = html(":::callout\nhello\n:::");
    expect(out).toContain("hello");
    expect(out).not.toContain(":::callout");
  });
});
