import { PrintQR } from "./PrintQR";

/**
 * Print-only footer rendered at the bottom of an event sheet (or
 * vendor-schedule sheet, or favorites sheet — the spec calls for the
 * same stylesheet on all three).
 *
 * Per MMATF-UIUX-PrintSheet-Spec Item 1 trailing block:
 *   - "QR code 'scan for live details & directions'"
 *   - "freshness stamp + canonical URL"
 *
 * Both delivered here. `hidden print:block` so it doesn't appear on
 * the screen version of the page.
 */
export function PrintEventSheetFooter({
  canonicalUrl,
  contextLabel = "Live details",
}: {
  canonicalUrl: string;
  /**
   * What the QR points to in natural language ("Live details & directions"
   * for an event, "Your saved events" for a vendor schedule, etc.).
   */
  contextLabel?: string;
}) {
  const printedOn = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    <div className="hidden print:block mt-8 pt-4 border-t border-black/30 text-xs text-black">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1">
          <p className="font-semibold text-sm">{contextLabel} — scan QR or visit:</p>
          <p className="mt-1 font-mono text-[10pt] break-all">{canonicalUrl}</p>
          <p className="mt-3 italic text-black/70">
            Printed from meetmeatthefair.com on {printedOn}. Details may have changed — confirm with
            the organizer for time-sensitive plans.
          </p>
        </div>
        {/* QR code is awaited server-side via PrintQR. */}
        <PrintQR url={canonicalUrl} size={120} />
      </div>
    </div>
  );
}
