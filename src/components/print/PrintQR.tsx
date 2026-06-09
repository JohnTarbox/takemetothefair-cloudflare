import QRCode from "qrcode";
import { logError } from "@/lib/logger";
import { getCloudflareDb } from "@/lib/cloudflare";

/**
 * Print-only QR code for the canonical URL — rendered as inline SVG
 * via React `<rect>` elements per QR cell.
 *
 * Per MMATF-UIUX-PrintSheet-Spec (Item 1): "QR code 'scan for live
 * details & directions' (print-specific; hands paper→digital)". The
 * fairs audience skews older + carries paper; the QR is the bridge
 * back to the live page.
 *
 * Implementation history:
 *   - PR #400 used `QRCode.toDataURL()` (PNG → data URL) with a
 *     comment claiming "edge-runtime-safe — qrcode's PNG generation
 *     path is pure JS." The claim verified only `lib/server.js`; the
 *     PNG renderer at `lib/renderer/png.js:1` does `require('fs')`
 *     and `Buffer.concat(...)` at line 49. Silently threw on the
 *     Pages edge runtime; the catch block returned null, so the QR
 *     was missing on every printed sheet since 2026-06-08. Pre-fix
 *     prod check: zero `data:image/png` bytes across multiple event
 *     page HTML responses.
 *   - This rewrite (2026-06-08 evening) switches to `QRCode.create()`
 *     which returns the QR bit-matrix struct (`{ modules: { size, data } }`)
 *     using only `Uint8Array` and pure-JS lib-internal modules — no
 *     `fs`, no `Buffer`. The matrix is rendered as React `<rect>`
 *     elements directly in JSX, sidestepping both the PNG path's
 *     edge-incompat AND `dangerouslySetInnerHTML` (the SVG renderer
 *     paths in qrcode would need it, and our security policy
 *     reasonably flags that broadly).
 *
 * XSS surface: none. The URL never reaches the DOM as text or HTML —
 * it's encoded into the QR module bit-matrix by `QRCode.create()`,
 * then each dark module becomes a `<rect>` with numeric x/y/width/height
 * attributes. No string interpolation into HTML at any point.
 *
 * Failure surface: catch logs to `error_logs` (vs. PR #400 returning
 * null silently) so any future qrcode-package upgrade that
 * re-introduces a `Buffer` reference will surface under the
 * `print/PrintQR` source filter rather than disappearing the QR
 * without explanation. The visible UX still degrades to "QR missing";
 * the URL text line in the surrounding PrintEventSheetFooter is the
 * paper→digital fallback.
 *
 * `hidden print:block` — invisible on screen, visible on print.
 */
export async function PrintQR({ url, size = 120 }: { url: string; size?: number }) {
  /** Quiet-zone in modules around the QR pattern. Standard recommends 4;
   *  we use 1 for compact print rendering — still scanner-friendly at the
   *  120px target size. */
  const margin = 1;

  let qrSize: number;
  let qrData: Uint8Array;
  try {
    const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
    qrSize = qr.modules.size;
    qrData = qr.modules.data;
  } catch (err) {
    try {
      await logError(getCloudflareDb(), {
        message: "QRCode.create failed in PrintQR",
        error: err,
        source: "print/PrintQR",
        context: { url, size },
      });
    } catch {
      // Logger itself unavailable (dev / test) — degrade to console
      // so `wrangler tail` still shows the failure.
      console.error("[PrintQR] QRCode.create failed and logger unreachable:", err);
    }
    return null;
  }

  const viewBoxSize = qrSize + margin * 2;

  // Build the dark-cell list ahead of the JSX so the return is compact
  // and the cell coordinates are all primitives in the React tree
  // (no string-to-HTML interpolation, no innerHTML).
  const cells: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < qrSize; row++) {
    for (let col = 0; col < qrSize; col++) {
      if (qrData[row * qrSize + col]) {
        cells.push({ x: col + margin, y: row + margin });
      }
    }
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="hidden print:block flex-shrink-0"
    >
      {/* Light background — a single rect underneath all dark cells.
          QR contrast requires explicit white background; without it
          the printed cells would sit on whatever the underlying page
          background is.

          Raw #ffffff / #000000 hex is intentional and an explicit
          escape from the design-system token rule: QR SCANNERS NEED
          MAXIMUM CONTRAST. Tokens like --background / --foreground
          theme with dark mode (cream / near-black), which would
          produce off-white / off-black on print and degrade scanner
          reliability. PR #400's original `QRCode.toDataURL()` omitted
          the `color` opt so the package emitted its #000/#fff
          internally for the same reason. This is the documented
          "chart viz" escape hatch from the eslint rule's docstring. */}
      {/* eslint-disable-next-line no-restricted-syntax */}
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      {cells.map((c, i) => (
        // eslint-disable-next-line no-restricted-syntax
        <rect key={i} x={c.x} y={c.y} width={1} height={1} fill="#000000" />
      ))}
    </svg>
  );
}
