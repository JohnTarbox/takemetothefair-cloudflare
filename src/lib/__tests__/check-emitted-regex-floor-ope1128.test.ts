/**
 * OPE-1128 — the post-build chunk guard. It must catch a lookbehind regex
 * LITERAL (a parse-time SyntaxError for the whole chunk in Safari < 16.4) and
 * must NOT flag the harmless forms: a lookbehind inside a string handed to
 * `new RegExp` in a try (core-js's feature test), in a comment, or a named
 * capture group (supported from Safari 11.1, below the floor).
 */
import { describe, it, expect } from "vitest";
import { findLookbehindLiterals } from "../../../scripts/check-emitted-regex-floor";

describe("OPE-1128 findLookbehindLiterals", () => {
  it("flags the real chunk-7466 literal (remark-gfm email autolink), minified in context", () => {
    const chunk =
      'var a=1;function b(c){return c.replace(/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu,"x")}';
    const r = findLookbehindLiterals(chunk);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0].literal).toContain("(?<=^|");
    expect(r.literals).toBe(1);
  });

  it("flags a negative lookbehind in the MIDDLE of a literal", () => {
    expect(findLookbehindLiterals("x=/free(?<!not )admission/i").offenders).toHaveLength(1);
  });

  it("ignores the feature-test shape: a string passed to new RegExp inside try", () => {
    const corejs = 'try{new RegExp("(?<=a)b");t=!0}catch(e){t=!1}';
    const r = findLookbehindLiterals(corejs);
    expect(r.offenders).toHaveLength(0);
  });

  it("ignores comments, template strings and named groups", () => {
    const code = [
      "// (?<=x) in a comment",
      "/* (?<!y) */",
      "var s=`(?<=z)`;",
      "var n=/(?<year>\\d{4})-(?<m>\\d{2})/;", // named groups: Safari 11.1+, allowed
    ].join("\n");
    const r = findLookbehindLiterals(code);
    expect(r.offenders).toHaveLength(0);
    // positive landmark: the named-group literal WAS examined, not skipped
    expect(r.literals).toBe(1);
  });

  it("tells division from a regex literal (no false positive on a/b<c)", () => {
    expect(findLookbehindLiterals("var q=a/(b)<(c);var r=x/2").offenders).toHaveLength(0);
  });
});
