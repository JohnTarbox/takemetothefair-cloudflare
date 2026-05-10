import type { Plugin } from "unified";
import type { Root } from "mdast";

type DirectiveNode = {
  type: "containerDirective" | "leafDirective" | "textDirective";
  name: string;
  attributes?: Record<string, string | null | undefined>;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  children?: unknown[];
};

type AnyNode = { type: string; children?: AnyNode[] } & Partial<DirectiveNode>;

function isDirective(node: AnyNode): node is DirectiveNode & AnyNode {
  return (
    node.type === "containerDirective" ||
    node.type === "leafDirective" ||
    node.type === "textDirective"
  );
}

// HTML/JSX tag names must start with a letter. remark-directive's permissive
// parser accepts directive *names* like "30am" or "1" (extracted from prose
// like "6:30am" or "1:1"), but those produce invalid React elements and crash
// the server-side render with "Invalid tag" errors. Restrict directive
// rewriting to names that actually look like component identifiers; everything
// else falls back to react-markdown's default text handling.
const VALID_DIRECTIVE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

function walk(node: AnyNode) {
  if (isDirective(node) && node.name && VALID_DIRECTIVE_NAME.test(node.name)) {
    const data = node.data ?? (node.data = {});
    data.hName = node.name;
    const attrs = node.attributes ?? {};
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) props[key] = value;
    }
    data.hProperties = props;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child);
  }
}

/**
 * Rewrites remark-directive nodes so react-markdown can resolve them
 * through its `components` map via the directive's name as the tag.
 * `::foo{bar="1"}` → `<foo bar="1">`, `:::foo` → `<foo>children</foo>`.
 */
export const remarkBlogEmbeds: Plugin<[], Root> = () => (tree) => {
  walk(tree as unknown as AnyNode);
};
