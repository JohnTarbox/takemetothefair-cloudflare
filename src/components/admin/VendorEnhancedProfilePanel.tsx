"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  vendorId: string;
  enhancedProfile: boolean;
  enhancedProfileStartedAt: Date | null;
  enhancedProfileExpiresAt: Date | null;
  galleryImages: string; // JSON-encoded array
  slug: string;
  featuredPriority: number;
}

interface GalleryImage {
  url: string;
  alt: string;
  caption?: string;
}

function parseGallery(json: string): GalleryImage[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function formatDate(d: Date | null) {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 10);
}

export function VendorEnhancedProfilePanel({
  vendorId,
  enhancedProfile,
  enhancedProfileStartedAt,
  enhancedProfileExpiresAt,
  galleryImages,
  slug,
  featuredPriority,
}: Props) {
  const initialGallery = parseGallery(galleryImages);
  const [gallery, setGallery] = useState<GalleryImage[]>(initialGallery);
  const [slugInput, setSlugInput] = useState(slug);
  const [priority, setPriority] = useState(featuredPriority);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const inGrace =
    enhancedProfile &&
    enhancedProfileExpiresAt !== null &&
    new Date(enhancedProfileExpiresAt).getTime() < Date.now();

  async function call(body: Record<string, unknown>) {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/admin/vendors/${vendorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStatusMsg(`Error: ${err.error ?? res.statusText}`);
      } else {
        setStatusMsg("Saved.");
        // Hard reload so the read-only fields above reflect the new state.
        setTimeout(() => window.location.reload(), 600);
      }
    } catch (e) {
      setStatusMsg(`Network error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function activate() {
    if (
      !confirm(
        "Activate Enhanced Profile for 1 year? This sets the verified badge and starts the paid period."
      )
    )
      return;
    call({ enhanced_profile: true, verified: true });
  }

  function startGrace() {
    if (
      !confirm(
        "Set expires_at to now? This starts the 30-day grace period; the daily sweep will flip the flag in 30 days."
      )
    )
      return;
    call({ enhanced_profile_expires_at: new Date().toISOString() });
  }

  function saveFields() {
    const body: Record<string, unknown> = {
      gallery_images: gallery,
      featured_priority: priority,
    };
    if (slugInput !== slug) body.slug = slugInput;
    call(body);
  }

  function updateGalleryItem(i: number, patch: Partial<GalleryImage>) {
    setGallery((g) => g.map((item, idx) => (idx === i ? { ...item, ...patch } : item)));
  }

  function addGallerySlot() {
    if (gallery.length >= 2) return;
    setGallery((g) => [...g, { url: "", alt: "" }]);
  }

  function removeGalleryItem(i: number) {
    setGallery((g) => g.filter((_, idx) => idx !== i));
  }

  return (
    <section className="border border-gray-200 rounded-lg p-6 bg-white">
      <h2 className="text-lg font-semibold mb-4">Enhanced Profile</h2>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 text-sm">
        <div>
          <dt className="text-gray-500">Status</dt>
          <dd className="font-medium">
            {enhancedProfile ? (inGrace ? "Active (in grace)" : "Active") : "Inactive"}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Started at</dt>
          <dd>{formatDate(enhancedProfileStartedAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Expires at</dt>
          <dd>{formatDate(enhancedProfileExpiresAt)}</dd>
        </div>
      </dl>

      {inGrace && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 mb-4 text-sm text-yellow-900">
          Expired {formatDate(enhancedProfileExpiresAt)} — features still visible during the 30-day
          grace period. Re-activate or wait for the daily sweep to revert.
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-6">
        <Button type="button" onClick={activate} disabled={saving}>
          Activate Enhanced Profile (1 year)
        </Button>
        <Button type="button" variant="outline" onClick={startGrace} disabled={saving}>
          Set Expiry Now (start grace)
        </Button>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="slugInput" className="block text-sm font-medium mb-1">
            Custom slug
          </label>
          <input
            id="slugInput"
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Changing this writes a redirect from the old slug. /vendors/[old-slug] → /vendors/
            {slugInput || "[new]"}
          </p>
        </div>

        <div>
          <label htmlFor="priority" className="block text-sm font-medium mb-1">
            Featured priority
          </label>
          <input
            id="priority"
            type="number"
            min={0}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            0 = participate in daily shuffle; &gt;0 = pinned above the shuffle, descending priority.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">Gallery images (max 2)</h3>
          {gallery.map((img, i) => (
            <div key={i} className="border border-gray-200 rounded-md p-3 mb-2 space-y-2">
              <input
                value={img.url}
                onChange={(e) => updateGalleryItem(i, { url: e.target.value })}
                placeholder="https://cdn.meetmeatthefair.com/vendors/..."
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={img.alt}
                onChange={(e) => updateGalleryItem(i, { alt: e.target.value })}
                placeholder="Alt text"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={img.caption ?? ""}
                onChange={(e) => updateGalleryItem(i, { caption: e.target.value })}
                placeholder="Caption (optional)"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => removeGalleryItem(i)}
                className="text-sm"
              >
                Remove
              </Button>
            </div>
          ))}
          {gallery.length < 2 && (
            <Button type="button" variant="outline" onClick={addGallerySlot}>
              Add image
            </Button>
          )}
        </div>

        <Button type="button" onClick={saveFields} disabled={saving}>
          {saving ? "Saving..." : "Save profile fields"}
        </Button>
      </div>

      {statusMsg && <p className="text-sm mt-3 text-gray-700">{statusMsg}</p>}
    </section>
  );
}
