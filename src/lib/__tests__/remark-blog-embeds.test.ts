import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkDirective from "remark-directive";
import { remarkBlogEmbeds } from "../remark-blog-embeds";

// Helper: parse markdown through the same pipeline `MarkdownContent` uses
// (minus react-markdown — we inspect the mdast directly), and collect
// every node that has a `data.hName` set after the plugin runs.
function collectHNames(markdown: string): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkDirective)
    .use(remarkBlogEmbeds)
    .parse(markdown);
  unified().use(remarkBlogEmbeds).runSync(tree);
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
  it("rewrites valid directive names to hName for react-markdown lookup", () => {
    expect(collectHNames(":::callout\nhello\n:::")).toContain("callout");
    expect(collectHNames("::inventory-calculator{vendors=10}")).toContain("inventory-calculator");
  });

  it("does NOT rewrite digit-prefixed directive names that arise from prose like `6:30am`", () => {
    // Regression test: production blog posts contained prose like
    //   "Arriving early (around 6–6:30am) gives you the best view"
    // remark-directive interpreted `:30am` as a text directive named "30am",
    // and the plugin previously set hName = "30am" → React rejected it as an
    // invalid tag and crashed the server-side render with HTTP 500.
    const names = collectHNames("Arriving early (around 6:30am) gives you the best view.");
    for (const n of names) {
      expect(n).toMatch(/^[A-Za-z]/);
      expect(n).not.toBe("30am");
    }
  });

  it("does NOT rewrite single-digit directive names from prose like `1:1`", () => {
    // Same class of bug, different trigger ("1:1 ratio" in tasting guide).
    const names = collectHNames("Mix sap and water at a 1:1 ratio for tasting.");
    for (const n of names) expect(n).toMatch(/^[A-Za-z]/);
  });

  it("does NOT rewrite plain-digit directive names like `:30`", () => {
    const names = collectHNames("Show starts at 7:30 sharp.");
    for (const n of names) expect(n).toMatch(/^[A-Za-z]/);
  });
});
