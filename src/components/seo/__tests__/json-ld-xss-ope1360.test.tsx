/**
 * OPE-1360 — stored XSS via JSON-LD.
 *
 * Bare `JSON.stringify` inside `<script type="application/ld+json">` lets a
 * field value containing `</script>` close the element; whatever follows is
 * parsed as HTML. The rendered-output test is the one that matters: it
 * asserts against the actual server-rendered markup of a real emitter, so it
 * goes red if the component ever stops routing through `safeJsonLd`.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VendorSchema } from "../VendorSchema";
import { safeJsonLd } from "@/lib/seo/safe-json-ld";

const PAYLOAD = "</script><script>alert(1)</script>";

function scriptBody(html: string): string {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return m![1];
}

describe("VendorSchema — JSON-LD script breakout (OPE-1360)", () => {
  it("a `</script>` in the description cannot close the script element", () => {
    const html = renderToStaticMarkup(
      <VendorSchema
        businessName="Evil & Co <b>"
        description={PAYLOAD}
        url="https://meetmeatthefair.com/vendors/evil"
      />
    );

    expect(html).not.toContain("</script><script>");
    // Exactly one closing tag: the element's own.
    expect(html.match(/<\/script>/g)).toHaveLength(1);

    const parsed = JSON.parse(scriptBody(html));
    expect(parsed.description).toBe(PAYLOAD);
    expect(parsed.name).toBe("Evil & Co <b>");
  });
});

describe("safeJsonLd", () => {
  const input = {
    a: PAYLOAD,
    b: "Tom & Jerry > Spike",
    c: "line\u2028para\u2029end",
    nested: [{ d: "<!-- -->" }, 1, true, null],
  };

  it("emits no raw <, >, &, U+2028 or U+2029", () => {
    const out = safeJsonLd(input);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
  });

  it("parses back to an identical value", () => {
    expect(JSON.parse(safeJsonLd(input))).toEqual(input);
  });

  it("drops undefined keys like JSON.stringify and never returns undefined", () => {
    expect(JSON.parse(safeJsonLd({ x: 1, y: undefined }))).toEqual({ x: 1 });
    expect(safeJsonLd(undefined)).toBe("null");
  });
});
