"use client";

import { useState } from "react";
import Link from "next/link";
import { Calendar, FileText, Tag } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatAuthorName } from "@/lib/utils";
import { formatDateLong } from "@/lib/datetime";
import { cdnImage } from "@/lib/cdn-image";

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
  /**
   * Set to true for the SINGLE LCP candidate per page only. Emits
   * `<link rel="preload" as="image">`. Multiple priority cards
   * compete and the browser deprioritizes them — see EventCard docs.
   */
  priority?: boolean;
}

export function BlogPostCard({ post, priority = false }: BlogPostCardProps) {
  const [imgError, setImgError] = useState(false);

  const publishDate = post.publishDate ? formatDateLong(post.publishDate) : null;

  return (
    <Card className="h-full hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden">
      <div className="h-1 bg-royal" />
      <Link href={`/blog/${post.slug}`} className="block">
        <div className="aspect-video relative bg-muted">
          {post.featuredImageUrl && !imgError ? (
            // IMG backlog closeout (2026-06-08) — applies the
            // cloudflare-image-optimization skill's card pattern: server-side
            // fit=cover at the right size + capped width ladder. Replaces
            // <Image fill> which went through the Next/Image custom loader
            // emitting width-only resizes up to 3840 (no fit/gravity, no
            // explicit dims), wasting bytes + tripping the spec's
            // "cap at ~1600-2048" rule.
            //
            // Same pattern as EventCard (PR #394) / VenueCard (PR #395):
            // raw <img> with manual srcSet, fit=cover at each variant width,
            // explicit width/height for CLS=0, fetchpriority/loading hooked
            // to the `priority` prop so the single-LCP-per-page rule holds.
            //
            // No `gravity` arg — center-crop matches industry baseline
            // (Eventbrite default, Lu.ma, Meetup) and avoids the saliency-
            // drift bug [[feedback_smart_crop_wrong_for_posters]]. Blog
            // featured images are typically photos with a clear subject,
            // so center-crop works for the 90% case. Per-image focal
            // point (PR #395) doesn't extend to blog posts yet (separate
            // schema column needed); follow-up if a blog hero ever needs
            // rescue.
            (() => {
              const cardWidths = [400, 600, 800, 1200];
              const cardSrcSet = cardWidths
                .map((w) =>
                  cdnImage(post.featuredImageUrl!, {
                    width: w,
                    height: Math.round((w * 9) / 16),
                    fit: "cover",
                    format: "auto",
                    quality: 80,
                    onerror: "redirect",
                  })
                )
                .map((url, i) => `${url} ${cardWidths[i]}w`)
                .join(", ");
              const cardSrc = cdnImage(post.featuredImageUrl, {
                width: 800,
                height: 450,
                fit: "cover",
                format: "auto",
                quality: 80,
                onerror: "redirect",
              });
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={cardSrc}
                  srcSet={cardSrcSet}
                  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                  alt={`Featured image for ${post.title}`}
                  width={800}
                  height={450}
                  loading={priority ? "eager" : "lazy"}
                  fetchPriority={priority ? "high" : "auto"}
                  decoding="async"
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={() => setImgError(true)}
                />
              );
            })()
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
          <h3 className="text-lg font-semibold text-navy line-clamp-2 group-hover:text-navy">
            {post.title}
          </h3>
          {post.excerpt && (
            <p className="text-sm text-muted-foreground line-clamp-3">{post.excerpt}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
            {publishDate && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {publishDate}
              </span>
            )}
            {formatAuthorName(post.authorName) && <span>{formatAuthorName(post.authorName)}</span>}
          </div>
          {post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {post.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 text-xs px-2 py-0.5 bg-muted text-muted-foreground rounded-full"
                >
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </span>
              ))}
              {post.tags.length > 3 && (
                <span className="text-xs text-muted-foreground">+{post.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </Link>
    </Card>
  );
}
