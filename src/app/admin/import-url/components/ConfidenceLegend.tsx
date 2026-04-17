"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { ConfidenceBadge } from "@/components/ui/confidence-badge";

const DISMISS_KEY = "mmatf.import-url.legend.collapsed";

/**
 * Collapsible legend explaining the confidence pills rendered on each
 * review-step field. Persists open/closed state per session so repeat
 * admins aren't nagged.
 */
export function ConfidenceLegend() {
  // Default collapsed on SSR; open on first hydrate unless dismissed before.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
      if (!dismissed) setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      sessionStorage.setItem(DISMISS_KEY, next ? "0" : "1");
    } catch {
      /* ignore */
    }
  };

  const sample = { verified: "high", ai: "medium", missing: "low" } as const;

  return (
    <div className="mb-4 rounded-lg border border-stone-100 bg-stone-50">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm font-medium text-stone-900 hover:bg-stone-100 rounded-lg"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-stone-600" aria-hidden />
        ) : (
          <ChevronRight className="w-4 h-4 text-stone-600" aria-hidden />
        )}
        <Info className="w-4 h-4 text-stone-600" aria-hidden />
        What do the pills next to each field mean?
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 text-sm text-stone-900 space-y-1.5">
          <div className="flex items-start gap-2">
            <ConfidenceBadge field="verified" confidence={sample} />
            <span>
              matched structured data (schema.org JSON-LD) or a strong page signal — generally safe
              to accept as-is.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <ConfidenceBadge field="ai" confidence={sample} />
            <span>AI best-guess from the page text — worth a quick review before saving.</span>
          </div>
          <div className="flex items-start gap-2">
            <ConfidenceBadge field="missing" confidence={sample} />
            <span>no value was found — fill it in if the event actually has one.</span>
          </div>
        </div>
      )}
    </div>
  );
}
