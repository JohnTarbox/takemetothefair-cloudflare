import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkDirective from "remark-directive";
import { remarkBlogEmbeds, type RemarkBlogEmbedsOptions } from "../remark-blog-embeds";

// Mirror the production allowlist (the registered components in
// src/components/blog/embeds/registry.ts). Hardcoded in tests so a future
// addition to BLOG_EMBEDS doesn't silently change test behavior.
const ALLOW: RemarkBlogEmbedsOptions["allow"] = ["callout", "inventory-calculator"];

// Helper: parse markdown through the same pipeline `MarkdownContent` uses
// (minus react-markdown — we inspect the mdast directly), and collect
// every node that has a `data.hName` set after the plugin runs.
function collectHNames(markdown: string, allow = ALLOW): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkDirective)
    .use(remarkBlogEmbeds, { allow })
    .parse(markdown);
  unified().use(remarkBlogEmbeds, { allow }).runSync(tree);
  const names: string[] = [];
  function walk(node: { data?: { hName?: unknown }; children?: unknown[] }) {
    if (typeof node.data?.hName === "string") names.push(node.data.hName);
    if (Array.isArray(node.children)) {
      for (const c of node.children) walk(c as Parameters<typeof walk>[0]);
    }
  }
  walk(tree as Parameters<typeof walk>[0]);
  return names;
}

describe("remarkBlogEmbeds", () => {
  it("rewrites allowlisted directive names to hName for react-markdown lookup", () => {
    expect(collectHNames(":::callout\nhello\n:::")).toContain("callout");
    expect(collectHNames("::inventory-calculator{vendors=10}")).toContain("inventory-calculator");
  });

  it("does NOT rewrite directive names that aren't in the allowlist", () => {
    // Even valid-shape names like "foo" or "bar" should fall through if the
    // consumer hasn't registered a component for them — otherwise they'd
    // render as inert unknown elements with no semantic meaning.
    expect(collectHNames(":::unknown-directive\nbody\n:::")).not.toContain("unknown-directive");
    expect(collectHNames("::foo{bar=1}")).not.toContain("foo");
  });

  it("does NOT rewrite digit-prefixed directive names that arise from prose like `6:30am`", () => {
    // Regression test: production blog posts contained prose like
    //   "Arriving early (around 6–6:30am) gives you the best view"
    // remark-directive interpreted `:30am` as a text directive named "30am",
    // and the plugin previously set hName = "30am" → React rejected it as an
    // invalid tag and crashed the server-side render with HTTP 500.
    const names = collectHNames("Arriving early (around 6:30am) gives you the best view.");
    expect(names).not.toContain("30am");
  });

  it("does NOT rewrite single-digit directive names from prose like `1:1`", () => {
    // Same class of bug, different trigger ("1:1 ratio" in tasting guide).
    expect(collectHNames("Mix sap and water at a 1:1 ratio for tasting.")).not.toContain("1");
  });

  it("does NOT rewrite plain-digit directive names like `:30`", () => {
    expect(collectHNames("Show starts at 7:30 sharp.")).not.toContain("30");
  });

  it("is a no-op when allow is empty (safe default for unknown content)", () => {
    expect(collectHNames(":::callout\nhello\n:::", [])).toEqual([]);
    expect(collectHNames("::inventory-calculator{vendors=10}", [])).toEqual([]);
  });
});
