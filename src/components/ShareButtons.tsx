"use client";

import { useState, useRef, useEffect } from "react";
import { Share2, Twitter, Facebook, Linkedin, Mail, Link2, Check } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { trackShare, type ShareMethod, type ShareEntityType } from "@/lib/analytics";

// U7 / Phase D (2026-06-02) — trigger migrated from <Button size="sm">
// (~28px tall, icon + "Share" text) to icon-only IconButton size="md"
// (40px guaranteed hit area). The "Share" word is dropped; ShareButtons
// now sits beside FavoriteButton as a matching pair of round-ish
// icon-only actions in the event-detail header. Menu items get an
// explicit min-h-[40px] so keyboard / touch hit-areas are reliable
// regardless of font line-height. WCAG 2.2 AA 2.5.8.

interface ShareButtonsProps {
  url: string;
  title: string;
  description?: string;
  // ENG1.2 (2026-06-09) — share-method analytics requires the entity
  // identity for GA4 custom dimensions (entity_type, entity_id,
  // entity_slug). All three are required; callers that don't have a
  // DB id should pass the slug for both — share volume is too low
  // to justify a permissive type. See docs/eng1-audit.md §A.
  entityType: ShareEntityType;
  entityId: string;
  entitySlug: string;
}

export function ShareButtons({
  url,
  title,
  description,
  entityType,
  entityId,
  entitySlug,
}: ShareButtonsProps) {
  // ENG1.2 — close over the entity identity so each per-method handler
  // can fire the share event without repeating the 3-tuple.
  const fireShare = (method: ShareMethod) => {
    trackShare(method, entityType, entityId, entitySlug);
  };

  const [copied, setCopied] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);
  const encodedDescription = encodeURIComponent(description || "");

  const shareLinks = {
    twitter: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
    email: `mailto:?subject=${encodedTitle}&body=${encodedDescription ? encodedDescription + "%0A%0A" : ""}${encodedUrl}`,
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url);
      // Fire AFTER the clipboard write succeeds — a failed copy
      // shouldn't inflate the share counter.
      fireShare("copy");
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setIsOpen(false);
      }, 1500);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const openShareWindow = (shareUrl: string) => {
    window.open(shareUrl, "_blank", "width=600,height=400");
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <IconButton
        size="md"
        variant="ghost"
        aria-label={`Share ${title}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        // Match FavoriteButton's pill silhouette next door so the two
        // header actions read as a paired set.
        className="rounded-full bg-card shadow-md border border-border hover:shadow-lg transition-all"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        icon={<Share2 className="w-5 h-5 text-muted-foreground" />}
      />

      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-48 bg-card rounded-lg shadow-lg border border-border py-1 z-50"
          role="menu"
          aria-label="Share options"
        >
          <button
            onClick={() => {
              fireShare("twitter");
              openShareWindow(shareLinks.twitter);
            }}
            className="w-full min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted flex items-center gap-2"
            role="menuitem"
            aria-label="Share on Twitter"
          >
            <Twitter className="w-4 h-4" aria-hidden="true" />
            Twitter
          </button>
          <button
            onClick={() => {
              fireShare("facebook");
              openShareWindow(shareLinks.facebook);
            }}
            className="w-full min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted flex items-center gap-2"
            role="menuitem"
            aria-label="Share on Facebook"
          >
            <Facebook className="w-4 h-4" aria-hidden="true" />
            Facebook
          </button>
          <button
            onClick={() => {
              fireShare("linkedin");
              openShareWindow(shareLinks.linkedin);
            }}
            className="w-full min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted flex items-center gap-2"
            role="menuitem"
            aria-label="Share on LinkedIn"
          >
            <Linkedin className="w-4 h-4" aria-hidden="true" />
            LinkedIn
          </button>
          <a
            href={shareLinks.email}
            className="w-full min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted flex items-center gap-2"
            onClick={() => {
              // Email is an <a href="mailto:"> — the browser handles
              // navigation. Fire before the navigation; the page stays.
              fireShare("email");
              setIsOpen(false);
            }}
            role="menuitem"
            aria-label="Share via email"
          >
            <Mail className="w-4 h-4" aria-hidden="true" />
            Email
          </a>
          <button
            onClick={copyToClipboard}
            className="w-full min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted flex items-center gap-2"
            role="menuitem"
            aria-label={copied ? "Link copied" : "Copy link to clipboard"}
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-green-600" aria-hidden="true" />
                <span className="text-green-600">Copied!</span>
              </>
            ) : (
              <>
                <Link2 className="w-4 h-4" aria-hidden="true" />
                Copy Link
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
