"use client";

import { useState, useRef, useEffect } from "react";
import { Share2, Twitter, Facebook, Linkedin, Mail, Link2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ShareButtonsProps {
  url: string;
  title: string;
  description?: string;
}

export function ShareButtons({ url, title, description }: ShareButtonsProps) {
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        aria-label={`Share ${title}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Share2 className="w-4 h-4" aria-hidden="true" />
        Share
      </Button>

      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
          role="menu"
          aria-label="Share options"
        >
          <button
            onClick={() => openShareWindow(shareLinks.twitter)}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
            role="menuitem"
            aria-label="Share on Twitter"
          >
            <Twitter className="w-4 h-4" aria-hidden="true" />
            Twitter
          </button>
          <button
            onClick={() => openShareWindow(shareLinks.facebook)}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
            role="menuitem"
            aria-label="Share on Facebook"
          >
            <Facebook className="w-4 h-4" aria-hidden="true" />
            Facebook
          </button>
          <button
            onClick={() => openShareWindow(shareLinks.linkedin)}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
            role="menuitem"
            aria-label="Share on LinkedIn"
          >
            <Linkedin className="w-4 h-4" aria-hidden="true" />
            LinkedIn
          </button>
          <a
            href={shareLinks.email}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
            onClick={() => setIsOpen(false)}
            role="menuitem"
            aria-label="Share via email"
          >
            <Mail className="w-4 h-4" aria-hidden="true" />
            Email
          </a>
          <button
            onClick={copyToClipboard}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
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
