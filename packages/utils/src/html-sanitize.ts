/**
 * OPE-1392 (TPL-1) — allow-list HTML sanitizer for newsletter issue bodies.
 *
 * `newsletter_issues.html` is composed by an agent from DB event names (which
 * arrive through the public `suggest_event` path), stored as-is, broadcast to
 * every subscriber, and rendered on the public apex via
 * `dangerouslySetInnerHTML`. Any unescaped name in that composition is stored
 * XSS. This runs at write time (the send route + the MCP tool) and again at
 * render time (the public page + the broadcast enqueue), so rows written
 * before this shipped are covered too.
 *
 * Why a tokenizer and not DOMPurify: this must run in the Workers runtime
 * (both the OpenNext app and the MCP Worker), which has no DOM. The design is
 * deliberately simple and errs toward DROPPING:
 *
 *   - Output is RE-SERIALIZED, never passed through. Only allow-listed tags
 *     are emitted; every attribute is allow-listed per tag, re-quoted with `"`,
 *     and any `"` inside is encoded. Text never contains a raw `<`. So whatever
 *     the browser does with malformed input, the output it parses is a plain
 *     tree of formatting elements with inert attributes.
 *   - Raw-text elements (`script`, `style`, `iframe`, `textarea`, `noscript`,
 *     …) are dropped WITH their content. Comments, doctypes and processing
 *     instructions are dropped. Any other non-allowed tag (svg, math, form,
 *     input, object, …) is unwrapped — its tag is dropped and its text kept,
 *     and anything inside it is sanitized by the same rules.
 *   - `href` must parse as an absolute http(s)/mailto URL; `src` as http(s).
 *     A failing URL attribute is removed (the element stays).
 *   - `style` is kept (every stored issue is inline-styled email markup) but
 *     the whole attribute is dropped if, once entities/comments/escapes are
 *     considered, it contains `url(`, `expression(`, `javascript:`,
 *     `@import`, `behavior`, `-moz-binding` or a `position` declaration (a
 *     page-covering overlay on the public apex).
 *   - Open/close tags are balanced, so a stray `</div>` cannot close the
 *     page's own wrapper when the body is server-rendered into the apex page.
 *
 * Allow-list derived from a read of the stored issues on 2026-10-16 (10 sent
 * issues, see html-sanitize.test.ts): a, br, div, em, h1–h3, hr, img, p, span,
 * strong, table/tr/td/th with style/align/width/border/cellpadding/
 * cellspacing/role, img alt/src/width. Common formatting tags beyond those are
 * allowed so a future composition does not silently lose structure.
 */

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "col", "hr", "img"]);

/**
 * Dropped together with everything up to their end tag. These are the HTML
 * raw-text / escapable-raw-text elements (whose content the browser does NOT
 * parse as markup) plus a few whose content is never meant to be visible.
 */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes",
  "noscript",
  "template",
  "object",
  "applet",
  "head",
]);

/** Allowed on every allowed tag. */
const GLOBAL_ATTRS = new Set(["style", "title", "align", "valign", "dir", "lang", "role"]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name"]),
  img: new Set(["src", "alt", "width", "height", "border"]),
  table: new Set(["width", "border", "cellpadding", "cellspacing", "bgcolor", "height"]),
  td: new Set(["width", "height", "colspan", "rowspan", "bgcolor", "nowrap"]),
  th: new Set(["width", "height", "colspan", "rowspan", "bgcolor", "nowrap", "scope"]),
  tr: new Set(["bgcolor", "height"]),
  col: new Set(["width", "span"]),
  colgroup: new Set(["width", "span"]),
  font: new Set(["color", "face", "size"]),
  ol: new Set(["start", "type"]),
  ul: new Set(["type"]),
  li: new Set(["value"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  div: new Set(["width"]),
  hr: new Set(["width", "size", "noshade"]),
};

/** Attributes whose value is a URL, and which schemes each may carry. */
const URL_ATTRS: Record<string, ReadonlySet<string>> = {
  href: new Set(["http:", "https:", "mailto:"]),
  src: new Set(["http:", "https:"]),
  cite: new Set(["http:", "https:"]),
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  tab: "\t",
  newline: "\n",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  semi: ";",
  period: ".",
  comma: ",",
  excl: "!",
  num: "#",
  commat: "@",
  equals: "=",
};

/**
 * Decode character references the way an attribute value is decoded, closely
 * enough for a SAFETY CHECK (the emitted value stays the raw text). A named
 * reference this table does not know is left literal — which can only make a
 * URL fail to parse (`&` is not a scheme character), i.e. be dropped.
 */
export function decodeHtmlAttributeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff) return "�";
      if (code === 0) return "�";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "�";
      }
    }
    const v = NAMED_ENTITIES[ref.toLowerCase()];
    return v ?? m;
  });
}

function isAllowedUrl(raw: string, schemes: ReadonlySet<string>): boolean {
  // The browser strips leading/trailing C0+space and removes tab/CR/LF
  // anywhere before parsing, so "java\nscript:" is javascript: to it — and must
  // be to us.
  const decoded = decodeHtmlAttributeEntities(raw)
    .replace(/[\t\n\r]/g, "")

    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  if (!decoded) return false;
  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return false;
  }
  return schemes.has(parsed.protocol.toLowerCase());
}

const DANGEROUS_CSS =
  /url\(|expression\(|javascript:|vbscript:|@import|behavior|-moz-binding|(^|[;{\s])position\s*:/i;

function isAllowedStyle(raw: string): boolean {
  const decoded = decodeHtmlAttributeEntities(raw);
  // A CSS escape (`\75 rl(`) or a comment (`ur/**/l(`) can hide a keyword from
  // the pattern; no stored issue uses either, so their presence alone refuses.
  if (decoded.includes("\\") || decoded.includes("/*")) return false;

  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(decoded)) return false;
  return !DANGEROUS_CSS.test(decoded);
}

function encodeAttr(raw: string): string {
  // The value is kept as written (its character references mean the same in
  // any quoting), only re-quoted. `<`/`>` are encoded too so no `<` ever
  // reaches the output outside a tag we built.
  return raw.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeAttr(tag: string, name: string, raw: string): string | null {
  if (!GLOBAL_ATTRS.has(name) && !TAG_ATTRS[tag]?.has(name)) return null;
  const schemes = URL_ATTRS[name];
  if (schemes) return isAllowedUrl(raw, schemes) ? raw : null;
  if (name === "style") return isAllowedStyle(raw) ? raw : null;
  if (name === "target") return /^_blank$/i.test(raw.trim()) ? "_blank" : null;
  return raw;
}

const WS = /[\t\n\f\r ]/;

interface ParsedTag {
  name: string;
  attrs: Array<[string, string]>;
  selfClosing: boolean;
  end: number; // index just past the closing `>`
}

/** Parse a start tag beginning at `<` (s[i] === "<", s[i+1] is a letter). */
function parseStartTag(s: string, i: number): ParsedTag | null {
  let j = i + 1;
  let name = "";
  while (j < s.length && !WS.test(s[j]) && s[j] !== "/" && s[j] !== ">") name += s[j++];
  const attrs: Array<[string, string]> = [];
  let selfClosing = false;
  while (j < s.length) {
    const c = s[j];
    if (WS.test(c)) {
      j++;
      continue;
    }
    if (c === ">") return { name: name.toLowerCase(), attrs, selfClosing, end: j + 1 };
    if (c === "/") {
      selfClosing = s[j + 1] === ">";
      j++;
      continue;
    }
    // Attribute name: per the spec a leading `=` is part of the name.
    let an = s[j++];
    while (j < s.length && !WS.test(s[j]) && s[j] !== "/" && s[j] !== ">" && s[j] !== "=")
      an += s[j++];
    while (j < s.length && WS.test(s[j])) j++;
    let value = "";
    if (s[j] === "=") {
      j++;
      while (j < s.length && WS.test(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        if (close === -1) return null; // EOF inside a quoted value: tag dropped
        value = s.slice(j + 1, close);
        j = close + 1;
      } else {
        while (j < s.length && !WS.test(s[j]) && s[j] !== ">") value += s[j++];
      }
    }
    const lname = an.toLowerCase();
    if (!attrs.some(([n]) => n === lname)) attrs.push([lname, value]);
  }
  return null; // EOF inside a tag: the browser drops it, so do we
}

/**
 * Sanitize an HTML fragment to the newsletter allow-list. Idempotent:
 * `sanitizeNewsletterHtml(sanitizeNewsletterHtml(x)) === sanitizeNewsletterHtml(x)`.
 */
export function sanitizeNewsletterHtml(input: string): string {
  const s = input.replace(/\u0000/g, "");
  let out = "";
  const stack: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    i = lt;
    const next = s[i + 1] ?? "";

    if (s.startsWith("<!--", i)) {
      const close = s.indexOf("-->", i + 4);
      i = close === -1 ? s.length : close + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const close = s.indexOf(">", i + 2);
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (next === "/" && /[a-z]/i.test(s[i + 2] ?? "")) {
      const close = s.indexOf(">", i + 2);
      if (close === -1) break; // EOF inside an end tag: dropped
      const m = /^[^\t\n\f\r />]+/.exec(s.slice(i + 2, close));
      const name = (m?.[0] ?? "").toLowerCase();
      i = close + 1;
      if (ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) {
        const at = stack.lastIndexOf(name);
        if (at !== -1) {
          while (stack.length > at) out += `</${stack.pop()}>`;
        }
      }
      continue;
    }
    if (/[a-z]/i.test(next)) {
      const tag = parseStartTag(s, i);
      if (!tag) break; // unterminated tag runs to EOF: drop the rest
      i = tag.end;
      if (DROP_WITH_CONTENT.has(tag.name)) {
        // Skip to the matching end tag (case-insensitive). Raw-text content is
        // not markup to the browser, so nothing inside is kept.
        const re = new RegExp(`</${tag.name}[\\t\\n\\f\\r />]`, "i");
        const rest = s.slice(i);
        const m = re.exec(rest);
        if (!m) {
          i = s.length;
        } else {
          const close = s.indexOf(">", i + m.index);
          i = close === -1 ? s.length : close + 1;
        }
        continue;
      }
      if (tag.name === "plaintext") {
        i = s.length;
        continue;
      }
      if (!ALLOWED_TAGS.has(tag.name)) continue;
      let attrs = "";
      for (const [name, raw] of tag.attrs) {
        const v = sanitizeAttr(tag.name, name, raw);
        if (v !== null) attrs += ` ${name}="${encodeAttr(v)}"`;
      }
      if (VOID_TAGS.has(tag.name)) {
        out += `<${tag.name}${attrs}${tag.selfClosing ? " />" : ">"}`;
      } else {
        out += `<${tag.name}${attrs}>`;
        stack.push(tag.name);
      }
      continue;
    }
    // A `<` that does not open a tag is text.
    out += "&lt;";
    i++;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
