/**
 * VendorMonogramLogo — placeholder tile for vendors without an
 * uploaded logo.
 *
 * UX-A2 Part A (MMATF-UIUX-VendorClaim-Spec):
 *
 *   > Logo placeholder — replace the blank logo box with a deliberate
 *   > colored monogram tile (initials + category color). Never an
 *   > empty/broken-looking square.
 *
 * Pre-fix the unclaimed-vendor logo slot was a generic Lucide `Store`
 * icon over a gray `bg-muted` square. Reads "abandoned" — visually
 * indistinguishable from a broken image. The monogram is a deliberate
 * design choice: claimed brand identity (the initials) on a tile color
 * derived from the vendor's category, communicating "we know who this
 * is, the owner just hasn't uploaded a logo yet."
 *
 * Color comes from a hash of the businessName so it's stable per-
 * vendor (same vendor always gets the same tile color) and visually
 * distinct across the directory grid. Six palette entries chosen from
 * the existing design-system accent tokens so the tiles theme in
 * dark mode and stay visually coherent with the rest of the site.
 *
 * Initials: first letter of the first 1-2 words, max 2 chars. So
 * "A & S Boats" → "AS"; "Maine Cardworks" → "MC"; "X" → "X".
 */

const MONOGRAM_PALETTE: Array<{ bg: string; fg: string }> = [
  // Sourced from the design-system semantic accent tokens (PR #391 sweep).
  // Each pair is a darker accent + a contrasting light text color so the
  // monogram is readable in both light and dark themes via CSS-var-backed
  // Tailwind utilities.
  { bg: "bg-accent-gold", fg: "text-primary-foreground" }, // gold + dark
  { bg: "bg-accent-terracotta", fg: "text-primary-foreground" }, // terracotta + dark
  { bg: "bg-accent-sage", fg: "text-primary-foreground" }, // sage + dark
  { bg: "bg-accent-navy-soft", fg: "text-secondary-foreground" }, // navy + light
  { bg: "bg-accent-stone", fg: "text-primary-foreground" }, // stone + dark
  { bg: "bg-secondary", fg: "text-secondary-foreground" }, // navy + light (5/6 ≠)
];

/**
 * Deterministic small hash — `name.length` plus the codepoint sum of
 * the first 4 chars. Cheap, no library, and stable across renders so
 * a vendor's tile color doesn't shuffle between page loads. Not a
 * cryptographic hash; correctness only requires "different inputs
 * tend to land on different palette entries."
 */
function paletteIndexFor(name: string): number {
  let n = name.length;
  for (let i = 0; i < Math.min(name.length, 4); i++) {
    n += name.charCodeAt(i);
  }
  return n % MONOGRAM_PALETTE.length;
}

/**
 * Up to 2 initials: first letter of each of the first two non-empty
 * words. Filters short connectors (& / and / the) so "A & S Boats"
 * resolves to "AS", not "A&".
 */
function initialsFor(name: string): string {
  const SKIP = new Set(["&", "and", "the", "of", "/"]);
  const words = name
    .replace(/[^\p{L}\p{N}\s/&-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !SKIP.has(w.toLowerCase()));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

export type VendorMonogramLogoProps = {
  businessName: string;
  /** Pixel size of the square tile. Defaults to 96 (medium card slot). */
  size?: number;
  className?: string;
};

export function VendorMonogramLogo({
  businessName,
  size = 96,
  className = "",
}: VendorMonogramLogoProps) {
  const initials = initialsFor(businessName);
  const { bg, fg } = MONOGRAM_PALETTE[paletteIndexFor(businessName)]!;
  // Font sized to ~50% of tile so two-letter monograms fit comfortably.
  const fontSize = Math.round(size * 0.5);
  return (
    <div
      className={`${bg} ${fg} flex items-center justify-center rounded-xl font-bold select-none ${className}`}
      style={{ width: size, height: size, fontSize }}
      aria-label={`${businessName} logo placeholder`}
      role="img"
    >
      {initials}
    </div>
  );
}
