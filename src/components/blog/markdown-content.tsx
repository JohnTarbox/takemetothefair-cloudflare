"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeExternalLinks from "rehype-external-links";

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="prose prose-lg max-w-none prose-headings:text-navy prose-a:text-royal prose-a:underline hover:prose-a:text-royal/80 prose-img:rounded-lg prose-blockquote:border-royal/30 prose-blockquote:text-gray-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }],
        ]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
