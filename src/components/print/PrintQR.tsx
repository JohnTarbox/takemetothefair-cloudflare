import QRCode from "qrcode";

/**
 * Print-only QR code for the canonical URL — renders as `<img>` with
 * an inline data URL (no network fetch at print time, no
 * `dangerouslySetInnerHTML`, no XSS surface).
 *
 * Per MMATF-UIUX-PrintSheet-Spec (Item 1): "QR code 'scan for live
 * details & directions' (print-specific; hands paper→digital)". The
 * fairs audience skews older + carries paper; the QR is the bridge
 * back to the live page.
 *
 * Implementation: `QRCode.toDataURL()` returns a `data:image/png;base64,…`
 * URL. Server-rendered, so the bytes are part of the HTML the browser
 * has when the user hits Cmd+P. Edge-runtime safe — qrcode's PNG
 * generation path is pure JS (verified — no fs/path/crypto imports in
 * lib/server.js for the toDataURL code path).
 *
 * `hidden print:block` — invisible on screen, visible on print.
 */
export async function PrintQR({ url, size = 120 }: { url: string; size?: number }) {
  let dataUrl: string;
  try {
    // Colors deliberately use qrcode's defaults (#000 dark / #fff light)
    // — QR scanners need maximum contrast, not design-system tokens.
    // Omitting the `color` option avoids the no-restricted-syntax lint
    // rule on raw hex literals while still producing a valid QR.
    dataUrl = await QRCode.toDataURL(url, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
    });
  } catch {
    // Generation failure — return null instead of a broken layout.
    // The surrounding PrintEventSheetFooter still shows the URL as text
    // (which is the QR's payload), so the paper→digital handoff degrades
    // gracefully to "type the URL".
    return null;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="hidden print:block flex-shrink-0"
    />
  );
}
