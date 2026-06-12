"use client";

/**
 * B4-3 (Dev-Email-2026-06-11) — minimal blog focal-point editor.
 *
 * Blog is the only entity whose featured image had no interactive focal-
 * point picker: the backend has accepted `imageFocalX/Y` since #412/#413
 * (MCP `update_blog_post` + `PUT /api/blog-posts/[slug]`), but blog posts
 * are MCP-authored and there is no admin blog *form* to host the drag-the-
 * dot UI the other four entities got in #395. Rather than build a full blog
 * CRUD form, this is a focused, focal-only editor: load the post, drag the
 * dot, save just the two focal columns via the existing partial-update PUT.
 *
 * The PUT is a safe partial update — `blogPostUpdateSchema` re-declares
 * tags/categories/faqs/status as optional-without-default precisely so a
 * focal-only body can't reset them (and urlSchema/excerpt/etc. carry no
 * defaults either). We send ONLY imageFocalX/Y.
 */

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FocalPointPicker } from "@/components/admin/FocalPointPicker";

interface BlogPost {
  title: string;
  slug: string;
  featuredImageUrl: string | null;
  imageFocalX: number | null;
  imageFocalY: number | null;
}

export default function EditBlogFocalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();

  const [post, setPost] = useState<BlogPost | null>(null);
  const [focalX, setFocalX] = useState(0.5);
  const [focalY, setFocalY] = useState(0.5);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/blog-posts/${slug}`);
        if (!res.ok) throw new Error("Blog post not found");
        const data = (await res.json()) as BlogPost;
        if (cancelled) return;
        setPost(data);
        setFocalX(typeof data.imageFocalX === "number" ? data.imageFocalX : 0.5);
        setFocalY(typeof data.imageFocalY === "number" ? data.imageFocalY : 0.5);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load post");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSavedOk(false);
    try {
      // Focal-only partial update — see file header for why this can't
      // clobber other fields.
      const res = await fetch(`/api/blog-posts/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageFocalX: focalX, imageFocalY: focalY }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      setSavedOk(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link
        href="/admin/blog"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" />
        Back to blog coverage
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Featured-image focal point</CardTitle>
          {post && <p className="text-sm text-muted-foreground">{post.title}</p>}
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !post ? (
            <p className="text-sm text-red-600">{error || "Blog post not found."}</p>
          ) : !post.featuredImageUrl ? (
            <div className="p-4 rounded border border-border bg-muted/30 text-sm text-muted-foreground">
              This post has no featured image, so there&apos;s nothing to position. Set a featured
              image first (via the <code>update_blog_post</code> MCP tool or the blog API), then
              return here to place the focal point.
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-3">
                Drag the dot to mark the most-important part of the photo. Cards and heroes crop
                around this focal point instead of dumb-center. Center (0.5, 0.5) keeps the
                pre-focal-point crop URL, so leaving it centered costs no extra image transform.
              </p>
              <FocalPointPicker
                src={post.featuredImageUrl}
                x={focalX}
                y={focalY}
                onChange={(nx, ny) => {
                  setFocalX(nx);
                  setFocalY(ny);
                  setSavedOk(false);
                }}
              />
              <div className="mt-4 flex items-center gap-3">
                <Button type="button" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save focal point"}
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  x {focalX.toFixed(2)} · y {focalY.toFixed(2)}
                </span>
                {savedOk && <span className="text-xs text-green-600">Saved</span>}
                {error && <span className="text-xs text-red-600">{error}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
