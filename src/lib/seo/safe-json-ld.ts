/**
 * Serialise a value for embedding inside `<script type="application/ld+json">`
 * via `dangerouslySetInnerHTML` (OPE-1360).
 *
 * Bare `JSON.stringify` is NOT safe there: a string value containing
 * `</script>` closes the script element early, and whatever follows is parsed
 * as HTML — stored XSS from any vendor/venue/event/blog field. This escapes the
 * HTML-significant characters to JSON `\uXXXX` escapes, so the output contains
 * no `<`, `>` or `&` at all and `JSON.parse` of it yields the identical value:
 *
 *   `<` → `\u003c`, `>` → `\u003e`, `&` → `\u0026`,
 *   U+2028 → `\u2028`, U+2029 → `\u2029` (line/paragraph separators, which
 *   break JS parsers that treat the payload as script).
 *
 * The escapes only ever occur inside JSON string literals (JSON syntax itself
 * uses none of these characters), so the replacement is lossless.
 *
 * Every JSON-LD emitter must use this; `src/components/seo/__tests__/json-ld-guard.test.ts`
 * fails CI on any `application/ld+json` emitter that does not.
 */
export function safeJsonLd(value: unknown): string {
  // JSON.stringify(undefined) returns undefined; emit `null` so the script
  // body is always valid JSON.
  const json = JSON.stringify(value) ?? "null";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
