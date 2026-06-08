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
  claimed: boolean;
  claimedAt: Date | null;
  verifiedPro: boolean;
  verifiedProAt: Date | null;
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
  claimed,
  claimedAt,
  verifiedPro,
  verifiedProAt,
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

  function grantClaim() {
    if (
      !confirm(
        "Mark this vendor as Claimed? A 'Claimed' badge will appear on their public page and a confirmation email will be sent to the vendor's account email."
      )
    )
      return;
    call({ claimed: true });
  }

  function revokeClaim() {
    if (
      !confirm(
        "Revoke Claimed status? The 'Claimed' badge disappears immediately. No email is sent on revoke."
      )
    )
      return;
    call({ claimed: false });
  }

  function grantVerifiedPro() {
    if (
      !confirm(
        "Mark this vendor as Verified Pro? This signals that we have credentialed their identity (LLC verified, address confirmed, etc.). The 'Verified Pro' badge will appear on their public page. No vendor notification email is sent."
      )
    )
      return;
    call({ verified_pro: true });
  }

  function revokeVerifiedPro() {
    if (
      !confirm(
        "Revoke Verified Pro status? The 'Verified Pro' badge disappears immediately. No email is sent on revoke."
      )
    )
      return;
    call({ verified_pro: false });
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
    <section className="border border-border rounded-lg p-6 bg-card">
      <h2 className="text-lg font-semibold mb-4">Enhanced Profile</h2>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 text-sm">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-medium">
            {enhancedProfile ? (inGrace ? "Active (in grace)" : "Active") : "Inactive"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Started at</dt>
          <dd>{formatDate(enhancedProfileStartedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expires at</dt>
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

      <div className="border-t border-border pt-4 mb-6">
        <h3 className="text-sm font-semibold mb-2">Claimed status</h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Claimed</dt>
            <dd className="font-medium">{claimed ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Claimed at</dt>
            <dd>{formatDate(claimedAt)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {!claimed ? (
            <Button type="button" onClick={grantClaim} disabled={saving}>
              Mark as Claimed
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={revokeClaim} disabled={saving}>
              Revoke Claim
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Granting fires a confirmation email to the vendor account email. Revoke does not. The
          badge appears on /vendors/[slug] within the page revalidate window (5 min).
        </p>
      </div>

      <div className="border-t border-border pt-4 mb-6">
        <h3 className="text-sm font-semibold mb-2">Verified Pro status</h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Verified Pro</dt>
            <dd className="font-medium">{verifiedPro ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Verified at</dt>
            <dd>{formatDate(verifiedProAt)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {!verifiedPro ? (
            <Button type="button" onClick={grantVerifiedPro} disabled={saving}>
              Mark as Verified Pro
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={revokeVerifiedPro} disabled={saving}>
              Revoke Verified Pro
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Credentialed identity-verification signal — admin-only set. No vendor email on grant or
          revoke. Orthogonal to Claimed; admin grants each independently.
        </p>
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
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
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
            className="w-32 rounded-md border border-border px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            0 = participate in daily shuffle; &gt;0 = pinned above the shuffle, descending priority.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">Gallery images (max 2)</h3>
          {gallery.map((img, i) => (
            <div key={i} className="border border-border rounded-md p-3 mb-2 space-y-2">
              <input
                value={img.url}
                onChange={(e) => updateGalleryItem(i, { url: e.target.value })}
                placeholder="https://cdn.meetmeatthefair.com/vendors/..."
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <input
                value={img.alt}
                onChange={(e) => updateGalleryItem(i, { alt: e.target.value })}
                placeholder="Alt text"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <input
                value={img.caption ?? ""}
                onChange={(e) => updateGalleryItem(i, { caption: e.target.value })}
                placeholder="Caption (optional)"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
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

      {statusMsg && <p className="text-sm mt-3 text-foreground">{statusMsg}</p>}
    </section>
  );
}
