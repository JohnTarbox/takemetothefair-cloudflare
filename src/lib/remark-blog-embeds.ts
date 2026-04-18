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

function walk(node: AnyNode) {
  if (isDirective(node)) {
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
