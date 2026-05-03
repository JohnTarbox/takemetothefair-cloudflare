"use client";

import { useState } from "react";

interface Props {
  vendorId: string;
  currentLogoUrl: string | null;
}

export function VendorLogoUpload({ vendorId, currentLogoUrl }: Props) {
  const [logoUrl, setLogoUrl] = useState<string | null>(currentLogoUrl);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`/api/admin/vendors/${vendorId}/upload-logo`, {
        method: "POST",
        body: formData,
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok) {
        setError(json.error ?? `Upload failed (${res.status})`);
        return;
      }
      if (json.url) {
        setLogoUrl(json.url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setUploading(false);
      // Reset the input so the same file can be re-selected after a failure.
      e.target.value = "";
    }
  }

  return (
    <section className="border border-gray-200 rounded-lg p-6 bg-white">
      <h2 className="text-lg font-semibold mb-2">Logo</h2>
      <p className="text-sm text-gray-600 mb-4">
        Upload directly to R2 (cdn.meetmeatthefair.com). Max 2 MB. JPG, PNG, WebP, or SVG.
      </p>

      {logoUrl ? (
        <div className="mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl}
            alt="Vendor logo"
            className="w-32 h-32 object-contain border border-gray-200 rounded-md bg-gray-50"
          />
          <p className="text-xs text-gray-500 mt-1 break-all">{logoUrl}</p>
        </div>
      ) : (
        <div className="w-32 h-32 border border-dashed border-gray-300 rounded-md flex items-center justify-center text-gray-400 text-xs mb-4">
          No logo
        </div>
      )}

      {/*
        File picker styled as a button. Can't use the project's <Button>
        wrapper because it renders a real <button>, which would either swallow
        the implicit click-the-input-on-label-click behavior or require
        asChild support (Button doesn't have it). The styles here mirror the
        outline variant so it visually matches the rest of the admin UI.
      */}
      <label
        className={
          "inline-flex items-center justify-center font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-4 py-2 text-sm cursor-pointer transition-colors " +
          (uploading ? "opacity-50 pointer-events-none" : "")
        }
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/svg+xml"
          onChange={handleFileChange}
          disabled={uploading}
          className="hidden"
        />
        {uploading ? "Uploading..." : logoUrl ? "Replace logo" : "Upload logo"}
      </label>

      {error && <p className="text-sm text-red-700 mt-3">{error}</p>}
    </section>
  );
}
