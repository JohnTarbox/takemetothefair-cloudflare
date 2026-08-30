"use client";

import { useCallback, useEffect, useState } from "react";
import { VendorGalleryManager, type ManagedPhoto } from "./VendorGalleryManager";

/**
 * OPE-211 — fetches a vendor's gallery and hands it to the manager.
 *
 * Split from the manager so the manager stays a pure controlled component that
 * can be rendered from a server page with photos already in hand (the admin
 * surface does this), while a client page that only knows a vendorId can use
 * this instead.
 */
export function VendorGalleryLoader({ vendorId }: { vendorId: string }) {
  const [photos, setPhotos] = useState<ManagedPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/vendor-photos?vendorId=${encodeURIComponent(vendorId)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Could not load photos (${res.status})`);
        return;
      }
      const body = (await res.json()) as { photos: ManagedPhoto[] };
      setPhotos(body.photos);
      setError(null);
    } catch {
      setError("Could not load photos — check your connection.");
    }
  }, [vendorId]);

  useEffect(() => {
    void load();
  }, [load]);

  // An error state, never a silent empty gallery: "you have no photos" and "we
  // could not fetch your photos" look identical to a vendor and mean opposite
  // things.
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (photos === null) return <p className="text-sm text-muted-foreground">Loading photos…</p>;

  return <VendorGalleryManager vendorId={vendorId} photos={photos} onChanged={load} />;
}
