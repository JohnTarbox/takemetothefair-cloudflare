// OPE-1128 — a SERVER component on purpose. remark-gfm ships a lookbehind regex
// literal (email autolinks) that Safari < 16.4 cannot parse; as a client
// component it reached the browser and crashed every route sharing its chunk.
// Only the click listener needs the client: BlogOutboundClickTracker.
import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeExternalLinks from "rehype-external-links";
import { headingSlug } from "@/lib/markdown-utils";
import { remarkBlogEmbeds } from "@/lib/remark-blog-embeds";
import { BLOG_EMBEDS, BLOG_EMBED_NAMES } from "@/components/blog/embeds/registry";
import { BlogOutboundClickTracker } from "@/components/blog/blog-outbound-click-tracker";
import { eventHrefKey } from "@/lib/blog/event-guides";

interface MarkdownContentProps {
  content: string;
  /** BC2 (2026-06-08) — when present, internal /events|/vendors|/venues|/blog
   *  link clicks inside the prose container fire a `blog_outbound_click`
   *  GA4 event + a first-party beacon. Omitting it keeps the legacy zero-
   *  instrumentation behavior (no listener wired) — caller decides. */
  sourceSlug?: string;
  /** OPE-1188 — `/events/<slug>` → canonical `/events/<series>/<year>`, resolved
   *  server-side by `resolveEventHrefs`. A link not in the map keeps its href. */
  eventHrefMap?: Record<string, string>;
}

/**
 * Flatten react-markdown children into a plain string so we can derive a
 * stable anchor id from the heading text (matching extractHeadings).
 */
function nodeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(nodeText).join("");
  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    (children as { props?: { children?: ReactNode } }).props?.children !== undefined
  ) {
    return nodeText((children as { props: { children: ReactNode } }).props.children);
  }
  return "";
}

function Heading2({ children, ...rest }: ComponentProps<"h2">) {
  const id = headingSlug(nodeText(children));
  return (
    <h2 id={id} {...rest}>
      {children}
    </h2>
  );
}

function Heading3({ children, ...rest }: ComponentProps<"h3">) {
  const id = headingSlug(nodeText(children));
  return (
    <h3 id={id} {...rest}>
      {children}
    </h3>
  );
}

export function MarkdownContent({ content, sourceSlug, eventHrefMap }: MarkdownContentProps) {
  // OPE-1188 — blog bodies link events by the slug that was current when they
  // were written, each now a 301 hop. Rewrite to the canonical path at render;
  // the stored body is untouched.
  const Anchor = ({ href, ...rest }: ComponentProps<"a">) => {
    const key = eventHrefKey(href);
    const canonical = key && eventHrefMap ? eventHrefMap[key] : undefined;
    return <a href={canonical ?? href} {...rest} />;
  };
  return (
    <BlogOutboundClickTracker
      sourceSlug={sourceSlug}
      className="prose prose-lg max-w-none prose-headings:text-navy prose-headings:scroll-mt-20 prose-a:text-royal prose-a:underline hover:prose-a:text-royal/80 prose-img:rounded-lg prose-blockquote:border-royal/30 prose-blockquote:text-foreground"
    >
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkDirective,
          [remarkBlogEmbeds, { allow: BLOG_EMBED_NAMES }],
        ]}
        rehypePlugins={[
          [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }],
        ]}
        components={{
          h2: Heading2,
          h3: Heading3,
          a: Anchor,
          ...(BLOG_EMBEDS as Record<string, React.ComponentType<Record<string, unknown>>>),
        }}
      >
        {content}
      </ReactMarkdown>
    </BlogOutboundClickTracker>
  );
}
