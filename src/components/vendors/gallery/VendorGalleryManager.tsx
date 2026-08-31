"use client";

import { useState } from "react";
import Image from "next/image";
import { Star, Trash2, ArrowUp, ArrowDown, Loader2, Upload } from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";

/**
 * OPE-211 increments 2b + 3 — manage a vendor's gallery.
 *
 * ONE component for the admin surface and the vendor self-service surface. It
 * takes no "isAdmin" prop and renders no permission logic, because it has no
 * permission opinion: every action posts to the same routes, and the SERVER
 * decides. A component that branched on a role prop would be a second,
 * client-side copy of an authorization rule — trivially bypassed, and free to
 * drift from the real one.
 *
 * Legacy `gallery_images` entries render read-only. They have no
 * `vendor_photos` row and therefore no id, so every control here would 404 on
 * click; showing them disabled with a reason is honest, and hiding them would
 * make a vendor's existing photos look deleted.
 */
export interface ManagedPhoto {
  id: string | null;
  url: string;
  alt: string;
  caption?: string;
  isFeatured: boolean;
  isLegacy: boolean;
  /**
   * OPE-686 — render-time rotation. Without it the admin thumbnail keeps
   * showing the photo sideways after a successful rotate, which reads as the
   * tool having done nothing.
   */
  rotation?: 90 | 180 | 270;
}

interface Props {
  vendorId: string;
  photos: ManagedPhoto[];
  /** Called after a successful mutation so the parent can refresh. */
  onChanged?: () => void;
  /**
   * OPE-212 — which photo API to talk to.
   *
   * Events reuse this component rather than getting a second copy: the two
   * galleries differ only in their route prefix and the name of the owning-id
   * field. A forked component would be a second place for the "featured is
   * exclusive" and "legacy rows are read-only" rules to drift.
   *
   * Defaults to the vendor surface so every existing caller is unchanged.
   */
  apiBase?: string;
  /** Body key for the owning entity in the reorder call. */
  ownerField?: string;
  /** Omitted for events — there is no self-service upload path for them. */
  uploadEnabled?: boolean;
}

export function VendorGalleryManager({
  vendorId,
  photos: initial,
  onChanged,
  apiBase = "/api/vendor-photos",
  ownerField = "vendorId",
  uploadEnabled = true,
}: Props) {
  const [photos, setPhotos] = useState<ManagedPhoto[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, init: RequestInit, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        // Surface the server's reason. A silent failure here means a vendor
        // reorders their gallery, sees nothing move, and assumes the site is
        // broken — the exact complaint that started OPE-649.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        return false;
      }
      onChanged?.();
      return true;
    } catch {
      setError("Network error — nothing was changed.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    // OPE-686 — no `window.confirm`. The native dialog blocks the renderer,
    // which froze browser automation outright on 2026-08-31 and left a human
    // clicking OK by hand. The second click now happens in the page.
    if (await send(`${apiBase}/${id}`, { method: "DELETE" }, id)) {
      setPhotos((p) => p.filter((x) => x.id !== id));
    }
  }

  async function setFeatured(id: string) {
    if (
      await send(
        `${apiBase}/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isFeatured: true }),
        },
        id
      )
    ) {
      // Featured is exclusive per vendor — mirror the server's demotion of the
      // others rather than leaving two stars lit until a refresh.
      setPhotos((p) => p.map((x) => ({ ...x, isFeatured: x.id === id })));
    }
  }

  async function move(index: number, delta: number) {
    const next = [...photos];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // Only real rows can be ordered; legacy entries have no id to send.
    const ids = next.map((p) => p.id).filter((id): id is string => id !== null);
    setPhotos(next);
    await send(
      `${apiBase}/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [ownerField]: vendorId, photoIds: ids }),
      },
      `reorder-${index}`
    );
  }

  async function saveCaption(id: string, caption: string, altText: string) {
    await send(
      `${apiBase}/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption, altText }),
      },
      id
    );
  }

  async function upload(file: File) {
    setBusy("upload");
    setError(null);
    try {
      const body = new FormData();
      body.set("vendorId", vendorId);
      body.set("file", file);
      const res = await fetch(`${apiBase}/upload`, { method: "POST", body });
      if (!res.ok) {
        // The server's message is written for the vendor ("Your gallery is
        // full (20 photos)", "That image is 8.2 MB"). Showing a generic
        // failure instead would strand them with no idea what to change.
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Upload failed (${res.status})`);
        return;
      }
      onChanged?.();
    } catch {
      setError("Upload failed — check your connection.");
    } finally {
      setBusy(null);
    }
  }

  const uploader = !uploadEnabled ? null : (
    <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">
      {busy === "upload" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Upload className="h-4 w-4" />
      )}
      {busy === "upload" ? "Uploading…" : "Add a photo"}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        disabled={busy !== null}
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset the input so re-picking the SAME file fires change again —
          // otherwise a failed upload cannot be retried without picking a
          // different file, which reads as the button being dead.
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
    </label>
  );

  if (photos.length === 0) {
    return (
      <div>
        {error && (
          <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <p className="text-sm text-muted-foreground">No gallery photos yet.</p>
        {uploader}
      </div>
    );
  }

  return (
    <div>
      {error && (
        <p className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {photos.map((photo, i) => (
          <li
            key={photo.id ?? `legacy-${photo.url}`}
            className="flex gap-3 rounded-lg border border-border p-3"
          >
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded">
              <Image
                // `#rot=` is stripped by the Next/Image loader and turned into
                // `rotate=`; a fragment never reaches a server, so the URL
                // still resolves to the same object.
                src={photo.rotation ? `${photo.url}#rot=${photo.rotation}` : photo.url}
                alt={photo.alt}
                fill
                sizes="80px"
                className="object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              {photo.isLegacy ? (
                <p className="text-xs text-muted-foreground">
                  Stored in the older gallery format — not editable yet. It still shows on the
                  public page.
                </p>
              ) : (
                <>
                  <input
                    type="text"
                    defaultValue={photo.caption ?? ""}
                    placeholder="Caption (optional)"
                    maxLength={300}
                    onBlur={(e) => saveCaption(photo.id!, e.target.value, photo.alt)}
                    className="w-full rounded border border-border px-2 py-1 text-sm"
                  />
                  <input
                    type="text"
                    defaultValue={photo.alt}
                    placeholder="Alt text — describe the photo for screen readers"
                    maxLength={300}
                    onBlur={(e) => saveCaption(photo.id!, photo.caption ?? "", e.target.value)}
                    className="mt-2 w-full rounded border border-border px-2 py-1 text-sm"
                  />
                </>
              )}
            </div>
            {!photo.isLegacy && (
              <div className="flex shrink-0 items-start gap-1">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0 || busy !== null}
                  aria-label="Move photo up"
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === photos.length - 1 || busy !== null}
                  aria-label="Move photo down"
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setFeatured(photo.id!)}
                  disabled={busy !== null}
                  aria-label={photo.isFeatured ? "Featured photo" : "Make this the featured photo"}
                  aria-pressed={photo.isFeatured}
                  className={`rounded p-1.5 hover:bg-muted disabled:opacity-40 ${
                    photo.isFeatured ? "text-amber-500" : "text-muted-foreground"
                  }`}
                >
                  <Star className="h-4 w-4" fill={photo.isFeatured ? "currentColor" : "none"} />
                </button>
                <ConfirmButton
                  onConfirm={() => remove(photo.id!)}
                  disabled={busy !== null}
                  aria-label="Delete photo"
                  prompt="Delete?"
                  confirmLabel="Delete"
                  className="rounded p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
                >
                  {busy === photo.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </ConfirmButton>
              </div>
            )}
          </li>
        ))}
      </ul>
      {uploader}
    </div>
  );
}
