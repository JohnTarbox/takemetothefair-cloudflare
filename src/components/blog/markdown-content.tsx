"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeExternalLinks from "rehype-external-links";
import { headingSlug } from "@/lib/markdown-utils";
import { remarkBlogEmbeds } from "@/lib/remark-blog-embeds";
import { BLOG_EMBEDS, BLOG_EMBED_NAMES } from "@/components/blog/embeds/registry";
import { classifyBlogOutboundLink, trackBlogOutboundClick } from "@/lib/analytics";

interface MarkdownContentProps {
  content: string;
  /** BC2 (2026-06-08) — when present, internal /events|/vendors|/venues|/blog
   *  link clicks inside the prose container fire a `blog_outbound_click`
   *  GA4 event + a first-party beacon. Omitting it keeps the legacy zero-
   *  instrumentation behavior (no listener wired) — caller decides. */
  sourceSlug?: string;
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

export function MarkdownContent({ content, sourceSlug }: MarkdownContentProps) {
  const proseRef = useRef<HTMLDivElement | null>(null);

  // BC2 — delegated click attribution. One listener on the prose container
  // beats N listeners on every <a>, and the container outlives any
  // re-render of inner markdown nodes. The listener intentionally fires
  // BEFORE the navigation (default click action) — sendBeacon is queued
  // by the browser and survives the page transition, so the GA4 hit
  // doesn't depend on the new page rendering.
  useEffect(() => {
    if (!sourceSlug) return;
    const el = proseRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      // Bail on middle/right clicks + modified clicks (ctrl/cmd+click) —
      // those usually open a new tab and don't represent a real "I'm
      // leaving this blog post" intent.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as HTMLElement | null)?.closest("a");
      if (!link) return;
      const classified = classifyBlogOutboundLink(link.getAttribute("href"));
      if (!classified) return;
      trackBlogOutboundClick(sourceSlug, classified.targetType, classified.targetSlug);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [sourceSlug]);

  return (
    <div
      ref={proseRef}
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
          ...(BLOG_EMBEDS as Record<string, React.ComponentType<Record<string, unknown>>>),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
