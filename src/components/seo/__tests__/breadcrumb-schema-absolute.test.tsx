/**
 * OPE-631 — breadcrumb `item` must be an absolute URL.
 *
 * Google maps `item` to `@id` and rejects a relative value: *"Invalid URL in
 * field id (in itemListElement.item)"*, with the item name reported as `N/A`.
 * Six of the component's 35 callers passed root-relative paths — the entire
 * `/vendors/browse` + `/venues/browse` subtree, 91 pages.
 *
 * The rendered-output test is the one that matters. Testing the helper alone
 * would pass even if the component stopped calling it, which is the shape of
 * failure that produced the bug in the first place: the value was correct
 * everywhere except where it was actually emitted.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BreadcrumbSchema, absolutizeBreadcrumbUrl } from "../BreadcrumbSchema";

const SITE = "https://meetmeatthefair.com";

/** Pull the JSON-LD back out of the rendered <script>. */
function emitted(items: { name: string; url: string }[]) {
  const html = renderToStaticMarkup(<BreadcrumbSchema items={items} />);
  const json = html.replace(/^.*?>/s, "").replace(/<\/script>$/, "");
  return JSON.parse(json.replace(/\\u003c/g, "<"));
}

describe("every emitted item is absolute", () => {
  it("absolutizes the exact shape the six browse callers pass", () => {
    // Verbatim from src/app/vendors/browse/state/[state]/page.tsx.
    const schema = emitted([
      { name: "Home", url: "/" },
      { name: "Vendors", url: "/vendors" },
      { name: "Browse", url: "/vendors/browse" },
      { name: "Wisconsin", url: "/vendors/browse/state/wi" },
    ]);
    const urls = schema.itemListElement.map((e: { item: string }) => e.item);
    expect(urls).toEqual([
      SITE,
      `${SITE}/vendors`,
      `${SITE}/vendors/browse`,
      `${SITE}/vendors/browse/state/wi`,
    ]);
    // The assertion GSC actually makes.
    for (const u of urls) expect(u).toMatch(/^https:\/\//);
  });

  it('renders "/" as the bare origin, with no double slash', () => {
    // SITE_URL has no trailing slash, so a naive concat emits
    // `https://meetmeatthefair.com//` and disagrees with the 29 callers that
    // already pass absolute URLs.
    expect(absolutizeBreadcrumbUrl("/")).toBe(SITE);
    expect(absolutizeBreadcrumbUrl("/")).not.toContain("//meetmeatthefair.com//");
  });

  it("leaves an already-absolute URL untouched", () => {
    // 29 of 35 callers pass absolute URLs; this change must be a no-op for them.
    const url = `${SITE}/events/marshfield-fair/2026`;
    expect(absolutizeBreadcrumbUrl(url)).toBe(url);
    expect(absolutizeBreadcrumbUrl("http://example.com/x")).toBe("http://example.com/x");
    const schema = emitted([{ name: "Event", url }]);
    expect(schema.itemListElement[0].item).toBe(url);
  });

  it("keeps the OPE-182 `<` escaping intact", () => {
    // Same file, sibling hardening. A regression here would let an
    // operator-entered name break out of the JSON-LD block.
    const html = renderToStaticMarkup(
      <BreadcrumbSchema items={[{ name: "</script><b>x", url: "/x" }]} />
    );
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c");
  });
});
