/**
 * OPE-1392 — newsletter HTML allow-list sanitizer, the quote-escaping
 * `escapeHtml`, and the email-subject control-character strip.
 *
 * The two fixtures are stored `newsletter_issues.html` bodies of SENT issues
 * (public on /newsletter/<slug>), captured 2026-10-16. A read of ten sent
 * issues found: a, br, div, em, h1, h2, h3, hr, img, p, span, strong, table,
 * td, th, tr; attributes a[href,style], img[alt,src,style,width],
 * table[border,cellpadding,cellspacing,role,style,width], td/th[align,style],
 * tr[style], style on everything else; every href/src https; 49 HTML comments
 * (authoring notes such as `<!-- PICK 3 -->`). All ten sanitize to their
 * input byte-for-byte once comments are removed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeNewsletterHtml } from "../html-sanitize";
import { escapeHtml } from "../html-escape";
import { sanitizeEmailSubject } from "../email-subject";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const withoutComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

describe("sanitizeNewsletterHtml — stored issues render the same", () => {
  for (const name of ["newsletter-weekend-2026-10-16.html", "newsletter-vendor-2026-09-09.html"]) {
    it(`${name}: output equals the input minus comments, byte for byte`, () => {
      const raw = fixture(name);
      expect(raw.length).toBeGreaterThan(10_000);
      expect(sanitizeNewsletterHtml(raw)).toBe(withoutComments(raw));
    });
    it(`${name}: idempotent`, () => {
      const once = sanitizeNewsletterHtml(fixture(name));
      expect(sanitizeNewsletterHtml(once)).toBe(once);
    });
  }

  it("keeps the inline-styled email markup shape the composer emits", () => {
    const html =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
      '<tr style="background:#eef2f0;"><td align="left" style="padding:8px;">' +
      '<a href="https://meetmeatthefair.com/events/x?utm_source=newsletter&amp;utm_medium=email" style="color:#1f3a2d;">Fair &amp; Expo</a>' +
      '<img src="https://cdn.meetmeatthefair.com/a.jpg" alt="A" width="560" style="display:block;" />' +
      "<br /><em>Sat</em> &middot; <strong>Sun</strong></td></tr></table>";
    expect(sanitizeNewsletterHtml(html)).toBe(html);
  });
});

describe("sanitizeNewsletterHtml — XSS payloads", () => {
  const cases: Array<[string, string, string]> = [
    ["script element", "<p>a</p><script>alert(1)</script><p>b</p>", "<p>a</p><p>b</p>"],
    ["script, uppercase + attrs", '<SCRIPT type="text/javascript">alert(1)</SCRIPT>ok', "ok"],
    ["img onerror", '<img src="x" onerror="alert(1)">', "<img>"],
    [
      "img onerror with a valid src keeps the src only",
      '<img src="https://cdn.example.com/a.png" onerror=alert(1)>',
      '<img src="https://cdn.example.com/a.png">',
    ],
    ["javascript: href", '<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
    ["entity-encoded javascript: href", '<a href="javascript&colon;alert(1)">x</a>', "<a>x</a>"],
    ["numeric-entity javascript: href", '<a href="&#106;avascript:alert(1)">x</a>', "<a>x</a>"],
    ["tab-split javascript: href", '<a href="java\tscript:alert(1)">x</a>', "<a>x</a>"],
    ["leading-space javascript: href", '<a href=" javascript:alert(1)">x</a>', "<a>x</a>"],
    ["data: href", '<a href="data:text/html,<script>alert(1)</script>">x</a>', "<a>x</a>"],
    ["vbscript: href", "<a href='vbscript:msgbox(1)'>x</a>", "<a>x</a>"],
    ["svg onload", '<svg onload="alert(1)"><circle r="1"/></svg>after', "after"],
    ["svg with nested script", "<svg><script>alert(1)</script></svg>", ""],
    ["iframe", '<iframe src="https://evil.test"></iframe>x', "x"],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>', ""],
    ["style element", "<style>body{background:url(javascript:alert(1))}</style>x", "x"],
    [
      "form + input",
      '<form action="https://evil.test"><input name="pw"><button>Go</button></form>',
      "Go",
    ],
    ["object/embed", '<object data="x.swf"></object><embed src="x.swf">', ""],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', ""],
    ["base href", '<base href="https://evil.test/">', ""],
    ["body onload", '<body onload="alert(1)">x</body>', "x"],
    ["details ontoggle", "<details open ontoggle=alert(1)>x</details>", "x"],
    [
      "onmouseover on an allowed tag",
      '<div onmouseover="alert(1)" style="color:red">x</div>',
      '<div style="color:red">x</div>',
    ],
    [
      "attribute breakout via single quotes",
      "<p title='a\"><script>alert(1)</script>'>x</p>",
      '<p title="a&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</p>',
    ],
    ["unterminated tag at EOF", "<p>a</p><img src=x onerror=alert(1)//", "<p>a</p>"],
    ["comment-hidden markup", "<!--<img src=x onerror=alert(1)>-->x", "x"],
    ["noscript mXSS", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '<img>">'],
    ["textarea raw text", "<textarea><img src=x onerror=alert(1)></textarea>x", "x"],
    ["template", "<template><img src=x onerror=alert(1)></template>x", "x"],
    ["CSS expression", '<div style="width:expression(alert(1))">x</div>', "<div>x</div>"],
    ["CSS url()", '<div style="background:url(javascript:alert(1))">x</div>', "<div>x</div>"],
    ["CSS escape obfuscation", '<div style="background:\\75 rl(x)">x</div>', "<div>x</div>"],
    ["CSS comment obfuscation", '<div style="background:ur/**/l(x)">x</div>', "<div>x</div>"],
    ["CSS overlay", '<div style="position:fixed;top:0;left:0">x</div>', "<div>x</div>"],
    ["class/id dropped", '<p class="fixed inset-0" id="login">x</p>', "<p>x</p>"],
    ["NUL inside a tag name", "<scr\u0000ipt>alert(1)</scr\u0000ipt>", ""],
    ["stray close tags cannot escape the wrapper", "</div></article><p>x", "<p>x</p>"],
    ["bare < in text", "1 < 2 <3", "1 &lt; 2 &lt;3"],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => {
      const out = sanitizeNewsletterHtml(input);
      expect(out).toBe(expected);
      // Belt and braces: nothing executable survives in any case.
      expect(out).not.toMatch(
        /<script|<svg|<iframe|<style|\son\w+=|javascript:|<form|<object|<embed/i
      );
    });
  }

  it("keeps mailto: and http: links", () => {
    const html = '<a href="mailto:hello@meetmeatthefair.com">m</a><a href="http://x.test/">h</a>';
    expect(sanitizeNewsletterHtml(html)).toBe(html);
  });

  it("forces target to _blank only", () => {
    expect(sanitizeNewsletterHtml('<a href="https://x.test" target="_top">x</a>')).toBe(
      '<a href="https://x.test">x</a>'
    );
  });

  it("refuses img src that is not http(s)", () => {
    expect(sanitizeNewsletterHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">')).toBe(
      "<img>"
    );
  });

  it("closes tags left open, so a fragment cannot swallow the page", () => {
    expect(sanitizeNewsletterHtml("<div><p><strong>x")).toBe(
      "<div><p><strong>x</strong></p></div>"
    );
  });
});

describe("escapeHtml (TPL-5)", () => {
  it("escapes the quotes as well as & < >", () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });
  it("makes an attribute breakout inert", () => {
    expect(`<a href="${escapeHtml('https://x.test/" onclick="alert(1)')}">`).toBe(
      '<a href="https://x.test/&quot; onclick=&quot;alert(1)">'
    );
  });
});

describe("sanitizeEmailSubject (TPL-2)", () => {
  it("returns a clean subject unchanged, byte for byte", () => {
    const s = 'We received your event — "Fryeburg Fair" & more';
    expect(sanitizeEmailSubject(s)).toBe(s);
  });
  it("strips CR/LF header injection", () => {
    expect(sanitizeEmailSubject("Hello\r\nBcc: victim@example.com")).toBe(
      "Hello Bcc: victim@example.com"
    );
  });
  it("strips other control characters and Unicode line separators", () => {
    expect(sanitizeEmailSubject("a\tb\u0000c\u007fd e\u0085f")).toBe("a b c d e f");
  });
  it("trims a control run at either end", () => {
    expect(sanitizeEmailSubject("\nFair\n")).toBe("Fair");
  });
});
