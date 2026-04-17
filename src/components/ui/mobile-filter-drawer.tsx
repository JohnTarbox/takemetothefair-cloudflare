"use client";

import { useEffect, useState } from "react";
import { Filter, X } from "lucide-react";

interface Props {
  children: React.ReactNode;
  /** Shown on the mobile trigger button. */
  label?: string;
  /** Optional count shown as a chip on the trigger button (active filter count). */
  activeCount?: number;
}

/**
 * Shows filter sidebar inline on lg+ screens, collapses to a "Filters" button
 * that opens a full-screen overlay on smaller screens.
 *
 * Preserves the existing filter markup — callers wrap their sidebar `<aside>`
 * contents with this and the desktop rendering is unchanged.
 */
export function MobileFilterDrawer({ children, label = "Filters", activeCount }: Props) {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the overlay is open on mobile.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Mobile trigger */}
      <div className="lg:hidden mb-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-stone-100 text-stone-900 hover:bg-stone-300 transition-colors font-medium"
          aria-expanded={open}
          aria-controls="mobile-filter-panel"
        >
          <Filter className="w-4 h-4" aria-hidden />
          {label}
          {activeCount !== undefined && activeCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-amber text-navy text-xs font-semibold">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {/* Desktop rendering — always visible inline */}
      <div className="hidden lg:block">{children}</div>

      {/* Mobile overlay */}
      {open && (
        <div
          id="mobile-filter-panel"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="lg:hidden fixed inset-0 z-50 bg-white overflow-y-auto"
        >
          <div className="sticky top-0 z-10 flex items-center justify-between bg-white border-b border-stone-100 px-4 py-3">
            <span className="font-semibold text-stone-900">{label}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close filters"
              className="p-2 -m-2 text-stone-600 hover:text-stone-900"
            >
              <X className="w-5 h-5" aria-hidden />
            </button>
          </div>
          <div className="p-4">{children}</div>
          <div className="sticky bottom-0 bg-white border-t border-stone-100 px-4 py-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full py-2.5 rounded-lg bg-navy text-white font-semibold"
            >
              Apply filters
            </button>
          </div>
        </div>
      )}
    </>
  );
}
