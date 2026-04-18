"use client";

import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeExternalLinks from "rehype-external-links";
import { headingSlug } from "@/lib/markdown-utils";
import { remarkBlogEmbeds } from "@/lib/remark-blog-embeds";
import { BLOG_EMBEDS } from "@/components/blog/embeds/registry";

interface MarkdownContentProps {
  content: string;
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

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="prose prose-lg max-w-none prose-headings:text-navy prose-headings:scroll-mt-20 prose-a:text-royal prose-a:underline hover:prose-a:text-royal/80 prose-img:rounded-lg prose-blockquote:border-royal/30 prose-blockquote:text-gray-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, remarkBlogEmbeds]}
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
