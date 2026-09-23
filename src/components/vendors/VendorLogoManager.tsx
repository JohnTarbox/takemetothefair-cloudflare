"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2, Upload, Trash2, ImageOff } from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";

/**
 * OPE-1112 — upload, replace and remove your own logo.
 *
 * Carries no permission logic and takes no `isAdmin` prop, for the same reason
 * `VendorGalleryManager` doesn't: both actions post to a route that authorises
 * server-side via `authorizeVendorGallery`. A client-side role branch would be
 * a second copy of an authorization rule, trivially bypassed and free to drift
 * from the real one.
 *
 * Why this exists at all: the only vendor-facing way to set a logo was a text
 * box asking for an image URL. A maker with photos on her phone and a Facebook
 * page has no such URL, so she pastes her page link, and the page renders a
 * blank square. Eight prod rows looked exactly like that on 2026-09-22, all of
 * them typed in by claimed vendors. The URL field is still here for anyone who
 * does have a hosted image — it is now validated — but it is no longer the
 * only door.
 */
interface Props {
  vendorId: string;
  /** Current logo, or null. */
  logoUrl: string | null;
  /** Called after a successful change so the parent form can resync. */
  onChanged?: (logoUrl: string | null) => void;
}

export function VendorLogoManager({ vendorId, logoUrl, onChanged }: Props) {
  const [current, setCurrent] = useState<string | null>(logoUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A logo that 404s or is a page URL renders as nothing. Showing the vendor a
  // labelled "this image isn't loading" box instead of empty space is the
  // whole difference between her reporting the bug and her fixing it herself.
  const [brokenImage, setBrokenImage] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("vendorId", vendorId);
      body.append("file", file);
      const res = await fetch("/api/vendor-photos/logo", { method: "POST", body });
      const parsed = (await res.json().catch(() => ({}))) as {
        error?: string;
        url?: string;
      };
      if (!res.ok) {
        setError(parsed.error ?? `Upload failed (${res.status})`);
        return;
      }
      setBrokenImage(false);
      setCurrent(parsed.url ?? null);
      onChanged?.(parsed.url ?? null);
    } catch {
      setError("Upload failed — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vendor-photos/logo", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId }),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => ({}))) as { error?: string };
        setError(parsed.error ?? `Remove failed (${res.status})`);
        return;
      }
      setBrokenImage(false);
      setCurrent(null);
      onChanged?.(null);
    } catch {
      setError("Remove failed — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-4">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md border bg-muted">
          {current && !brokenImage ? (
            <Image
              src={current}
              alt="Your current logo"
              fill
              sizes="96px"
              className="object-contain"
              onError={() => setBrokenImage(true)}
              unoptimized
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
              <ImageOff className="h-5 w-5" aria-hidden="true" />
              <span className="px-1 text-center text-[10px] leading-tight">
                {brokenImage ? "Not loading" : "No logo"}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-4 w-4" aria-hidden="true" />
            )}
            {current ? "Replace logo" : "Upload logo"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so choosing the SAME file again still fires onChange —
                // otherwise a failed upload can't be retried without picking a
                // different file, which reads as the button being dead.
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
          </label>

          {current && (
            <div>
              <ConfirmButton
                onConfirm={remove}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                prompt="Remove your logo?"
                confirmLabel="Remove"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Remove
              </ConfirmButton>
            </div>
          )}

          <p className="text-xs text-muted-foreground">JPEG, PNG or WebP. Up to 5 MB.</p>
        </div>
      </div>

      {brokenImage && current && (
        <p className="text-sm text-amber-700 dark:text-amber-500">
          That logo isn&apos;t loading. If you pasted a link to a Facebook, Instagram or Etsy page,
          that&apos;s a web page rather than an image file — upload the picture itself instead.
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
