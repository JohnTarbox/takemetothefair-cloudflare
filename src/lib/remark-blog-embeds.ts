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

export interface RemarkBlogEmbedsOptions {
  /**
   * Names of components that the consumer's react-markdown `components` map
   * can render. Only directives whose `name` is in this allowlist get rewritten
   * to a custom hName; every other directive falls back to react-markdown's
   * default text handling.
   *
   * Why an allowlist (not a regex / not "any valid identifier"):
   * remark-directive's permissive parser produces text directives from prose
   * like "6:30am" (name="30am") or "1:1" (name="1"). Setting hName to those
   * crashes the SSR with "Invalid tag" errors. Even names that LOOK valid
   * (e.g. "foo") would render as inert unknown elements unless the consumer
   * has a component for them. Restricting to the registered set is the only
   * configuration where every rewritten directive renders something
   * intentional. (Empty/missing allow → plugin is a no-op, which is the
   * safe default for callers that haven't audited their content yet.)
   */
  allow?: ReadonlyArray<string>;
}

function walk(node: AnyNode, allow: ReadonlySet<string>) {
  if (isDirective(node) && node.name && allow.has(node.name)) {
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
    for (const child of node.children) walk(child, allow);
  }
}

/**
 * Rewrites remark-directive nodes so react-markdown can resolve them through
 * its `components` map. Only names listed in `options.allow` are rewritten —
 * see `RemarkBlogEmbedsOptions.allow` for why an allowlist is the right shape.
 *
 * `::foo{bar="1"}` → `<foo bar="1">`, `:::foo …` → `<foo>…</foo>`.
 */
export const remarkBlogEmbeds: Plugin<[RemarkBlogEmbedsOptions?], Root> = (options) => (tree) => {
  const allow = new Set(options?.allow ?? []);
  if (allow.size === 0) return;
  walk(tree as unknown as AnyNode, allow);
};
