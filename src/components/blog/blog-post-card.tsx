"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Calendar, FileText, Tag } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface BlogPostCardProps {
  post: {
    slug: string;
    title: string;
    excerpt: string | null;
    featuredImageUrl: string | null;
    authorName: string | null;
    tags: string[];
    categories: string[];
    status: string;
    publishDate: string | Date | null;
  };
  priority?: boolean;
}

export function BlogPostCard({ post, priority = false }: BlogPostCardProps) {
  const [imgError, setImgError] = useState(false);

  const publishDate = post.publishDate
    ? new Date(post.publishDate).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <Card className="h-full hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden">
      <div className="h-1 bg-royal" />
      <Link href={`/blog/${post.slug}`} className="block">
        <div className="aspect-video relative bg-gray-100">
          {post.featuredImageUrl && !imgError ? (
            <Image
              src={post.featuredImageUrl}
              alt={`Featured image for ${post.title}`}
              fill
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              className="object-cover"
              priority={priority}
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-royal/40">
              <FileText className="w-12 h-12" />
            </div>
          )}
          {post.status === "DRAFT" && (
            <div className="absolute top-3 left-3">
              <Badge variant="warning">Draft</Badge>
            </div>
          )}
        </div>
        <div className="p-4 space-y-2">
          <h2 className="text-lg font-semibold text-navy line-clamp-2 group-hover:text-royal">
            {post.title}
          </h2>
          {post.excerpt && (
            <p className="text-sm text-gray-600 line-clamp-3">{post.excerpt}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-gray-500 pt-1">
            {publishDate && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {publishDate}
              </span>
            )}
            {post.authorName && (
              <span>{post.authorName}</span>
            )}
          </div>
          {post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {post.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full"
                >
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </span>
              ))}
              {post.tags.length > 3 && (
                <span className="text-xs text-gray-400">+{post.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </Link>
    </Card>
  );
}
