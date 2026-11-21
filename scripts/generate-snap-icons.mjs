/**
 * OPE-1552 — render the Snap PWA icon set from one SVG glyph.
 *
 *   node scripts/generate-snap-icons.mjs
 *
 * Writes public/icons/snap/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png.
 * Only /snap-manifest.json and /admin/snap's metadata point at these; the
 * main site's manifest, favicon and /icons/icon-*.png are untouched.
 *
 * Colours are READ from the light-theme `--navy` / `--amber` tokens in
 * src/app/globals.css (first definition = :root; the .dark block re-maps
 * --navy to a sky blue, which is not the brand mark), so the icon cannot
 * drift from the brand token. Today: navy 30 39 97, amber 232 150 12.
 *
 * Geometry: `scale` is the camera body width as a fraction of the canvas.
 *   - "any" icons (192/512/apple): 0.70 — big, so it stays legible at 48 px.
 *   - maskable: 0.56 — the body's CORNERS sit inside the 40%-radius safe
 *     circle that Android guarantees survives any mask (asserted below).
 */
import sharp from "sharp";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "icons", "snap");

/** First (light :root) definition of `--<name>: R G B;` in globals.css → `rgb(R,G,B)`. */
function token(name) {
  const css = readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+) (\\d+) (\\d+);`));
  if (!m) throw new Error(`--${name} not found in globals.css`);
  return `rgb(${m[1]},${m[2]},${m[3]})`;
}
const NAVY = token("navy");
const AMBER = token("amber");

/** Camera glyph on a full-bleed navy square, in a 512 viewBox. */
export function snapSvg(scale) {
  const S = 512;
  const w = S * scale; // body width
  const h = w * 0.68; // body height
  const hump = { w: w * 0.36, h: w * 0.12 }; // viewfinder hump on top
  const totalH = h + hump.h;
  const x = (S - w) / 2;
  const y = (S - totalH) / 2 + hump.h; // body top, so body+hump is centred
  const r = w * 0.1; // body corner radius
  const cx = S / 2;
  const cy = y + h / 2;
  const lensOuter = h * 0.36;
  const lensRing = lensOuter * 0.72;
  const lensInner = lensOuter * 0.5;
  const flash = w * 0.055;
  return {
    w,
    totalH,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${NAVY}"/>
  <rect x="${cx - hump.w / 2}" y="${y - hump.h}" width="${hump.w}" height="${hump.h + r}" rx="${hump.h * 0.45}" fill="white"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="white"/>
  <circle cx="${cx}" cy="${cy}" r="${lensOuter}" fill="${NAVY}"/>
  <circle cx="${cx}" cy="${cy}" r="${lensRing}" fill="white"/>
  <circle cx="${cx}" cy="${cy}" r="${lensInner}" fill="${NAVY}"/>
  <circle cx="${x + w - r * 1.35}" cy="${y + r * 1.25}" r="${flash}" fill="${AMBER}"/>
</svg>`,
  };
}

async function render(scale, size, file) {
  const { svg } = snapSvg(scale);
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Safe-zone assertion for the maskable glyph — fail the run, not the phone.
  const m = snapSvg(0.56);
  const halfDiag = Math.hypot(m.w / 2, m.totalH / 2);
  if (halfDiag > 512 * 0.4)
    throw new Error(`maskable glyph corner ${halfDiag.toFixed(1)}px > safe radius 204.8px`);

  mkdirSync(OUT, { recursive: true });
  await render(0.7, 192, "icon-192.png");
  await render(0.7, 512, "icon-512.png");
  await render(0.7, 180, "apple-touch-icon.png");
  await render(0.56, 512, "icon-maskable-512.png");
  console.log(
    `wrote 4 icons to ${OUT} (maskable corner radius ${halfDiag.toFixed(1)}px ≤ 204.8px)`
  );
}
