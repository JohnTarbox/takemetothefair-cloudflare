"use client";

import { Printer } from "lucide-react";

/**
 * Print button — fires `window.print()` and itself hides on print.
 *
 * Per MMATF-UIUX-PrintSheet-Spec (Item 1): the spec recommends "Print +
 * Download PDF from the same stylesheet (PDF is print-to-PDF — near-free
 * once the stylesheet exists)". Modern browsers' "Save as PDF" is the
 * print dialog's destination dropdown, so a single `window.print()` call
 * covers both flows. No separate "Download PDF" button needed.
 *
 * The component is `print:hidden` so clicking it triggers print but the
 * button itself doesn't appear on the printed page.
 */
export function PrintButton({
  label = "Print",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={`print:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors ${className}`}
      aria-label={label}
    >
      <Printer className="w-4 h-4" aria-hidden="true" />
      {label}
    </button>
  );
}
