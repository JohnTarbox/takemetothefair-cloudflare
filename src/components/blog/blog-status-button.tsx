"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BlogStatusButtonProps {
  slug: string;
  currentStatus: string;
}

export function BlogStatusButton({ slug, currentStatus }: BlogStatusButtonProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const isPublished = currentStatus === "PUBLISHED";
  const newStatus = isPublished ? "DRAFT" : "PUBLISHED";
  const label = isPublished ? "Unpublish" : "Publish";

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (isPublished && !confirm("Unpublish this post? It will no longer be visible to the public.")) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/blog-posts/${encodeURIComponent(slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Failed: ${(data as Record<string, string>).error || res.statusText}`);
      }
    } catch {
      alert("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`w-full ${
        isPublished
          ? "bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300"
          : "bg-green-600 text-white hover:bg-green-700"
      }`}
    >
      {loading ? (
        "Updating..."
      ) : isPublished ? (
        <>
          <X className="w-4 h-4 mr-1.5" />
          {label}
        </>
      ) : (
        <>
          <Check className="w-4 h-4 mr-1.5" />
          {label}
        </>
      )}
    </Button>
  );
}
