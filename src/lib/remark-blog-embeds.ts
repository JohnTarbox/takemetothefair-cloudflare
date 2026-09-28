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
   * to a custom hName. A non-allowlisted TEXT directive is turned back into its
   * literal source text (OPE-1213); leaf/container ones are left as they were.
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

type Positioned = { position?: { start?: { offset?: number }; end?: { offset?: number } } };

/**
 * OPE-1213 — the literal source text of a directive the site does not render.
 *
 * Sliced from the original Markdown when positions are available (they are
 * whenever react-markdown parses a string), so the reader sees exactly what the
 * author wrote. Otherwise rebuilt from the node: `:` + name, plus a `[label]`
 * and `{attrs}` if it had them.
 */
function directiveSource(node: DirectiveNode & AnyNode & Positioned, src: string | null): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (src !== null && typeof start === "number" && typeof end === "number" && end > start) {
    return src.slice(start, end);
  }
  const label = (node.children ?? [])
    .map((c) => (c as { value?: unknown }).value)
    .filter((v): v is string => typeof v === "string")
    .join("");
  const attrs = Object.entries(node.attributes ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `:${node.name}${label ? `[${label}]` : ""}${attrs ? `{${attrs}}` : ""}`;
}

/**
 * OPE-1213 — put every non-allowlisted TEXT directive back as plain text.
 *
 * remark-directive reads the `:30` in "5:30 p.m." as a text directive named
 * "30". Left alone, react-markdown's unknown-node handler turned it into a
 * `<div>` wrapping the node's children — and `:30` has none — so the page read
 * "5<div></div> p.m.": the minutes silently gone from every clock time on the
 * blog (28 posts, 113 times). The old comment here said such directives fell
 * back to "default text handling"; they did not.
 *
 * Only TEXT directives: they are the ones prose produces (`6:30`, `1:1`,
 * `a:b`). Leaf/container directives need `::`/`:::` at the start of a line,
 * which only deliberate embed syntax writes.
 */
function revertTextDirectives(node: AnyNode, allow: ReadonlySet<string>, src: string | null) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child) => {
    if (child.type === "textDirective" && !(child.name && allow.has(child.name))) {
      return {
        type: "text",
        value: directiveSource(child as DirectiveNode & AnyNode & Positioned, src),
      } as unknown as AnyNode;
    }
    revertTextDirectives(child, allow, src);
    return child;
  });
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
export const remarkBlogEmbeds: Plugin<[RemarkBlogEmbedsOptions?], Root> =
  (options) => (tree, file) => {
    const allow = new Set(options?.allow ?? []);
    // Runs even with an empty allowlist: a prose `:30` must read as text for
    // every caller, not only those that registered embeds.
    const src = file && file.value !== undefined ? String(file.value) : null;
    revertTextDirectives(tree as unknown as AnyNode, allow, src);
    if (allow.size === 0) return;
    walk(tree as unknown as AnyNode, allow);
  };
