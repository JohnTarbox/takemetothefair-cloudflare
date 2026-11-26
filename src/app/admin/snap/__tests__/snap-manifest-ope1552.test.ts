/**
 * @vitest-environment node
 *
 * OPE-1552 — Snap installs with its OWN icon set and label, and the main
 * site's install is untouched. Reads the shipped files in public/, not a
 * helper: the manifest is what the phone fetches.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { metadata } from "../page";

const PUBLIC = path.join(process.cwd(), "public");
type Icon = { src: string; sizes: string; type: string; purpose?: string };
const readManifest = (f: string) =>
  JSON.parse(readFileSync(path.join(PUBLIC, f), "utf8")) as {
    name: string;
    short_name: string;
    id?: string;
    scope?: string;
    start_url: string;
    icons: Icon[];
  };

describe("OPE-1552 Snap PWA identity", () => {
  const snap = readManifest("snap-manifest.json");

  it("the Snap page links the Snap manifest and its own apple-touch-icon", () => {
    expect(metadata.manifest).toBe("/snap-manifest.json");
    expect(JSON.stringify(metadata.icons)).toContain("/icons/snap/apple-touch-icon.png");
    expect(metadata.appleWebApp).toMatchObject({ title: "Snap" });
  });

  it("is named Snap and scoped to /admin/snap", () => {
    expect(snap.short_name).toBe("Snap");
    expect(snap.name).toBe("MMATF Snap");
    expect(snap).toMatchObject({
      id: "/admin/snap",
      start_url: "/admin/snap",
      scope: "/admin/snap",
    });
  });

  it("declares 192, 512 and 512-maskable, all under /icons/snap/", () => {
    const keys = snap.icons.map((i) => `${i.sizes}:${i.purpose ?? "any"}`).sort();
    expect(keys).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
    for (const i of snap.icons) expect(i.src.startsWith("/icons/snap/")).toBe(true);
  });

  it("every declared icon exists as a PNG of exactly the declared size", async () => {
    const icons = [
      ...snap.icons,
      { src: "/icons/snap/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ];
    expect(icons).toHaveLength(4); // positive landmark: four files examined
    for (const i of icons) {
      const meta = await sharp(path.join(PUBLIC, i.src)).metadata();
      expect(meta.format).toBe("png");
      expect(`${meta.width}x${meta.height}`).toBe(i.sizes);
    }
  });

  it("the maskable icon keeps the glyph inside the 40% safe circle", async () => {
    // Everything outside the safe circle must be plain navy background, so a
    // circle mask clips nothing but background.
    const { data, info } = await sharp(path.join(PUBLIC, "/icons/snap/icon-maskable-512.png"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const c = info.width / 2;
    const safe = info.width * 0.4;
    let outside = 0;
    let offBackground = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        if (Math.hypot(x + 0.5 - c, y + 0.5 - c) <= safe) continue;
        outside++;
        const o = (y * info.width + x) * 3;
        if (
          Math.abs(data[o] - 0x1e) > 2 ||
          Math.abs(data[o + 1] - 0x27) > 2 ||
          Math.abs(data[o + 2] - 0x61) > 2
        )
          offBackground++;
      }
    expect(outside).toBeGreaterThan(100_000); // the check examined the ring
    expect(offBackground).toBe(0);
  });

  it("the main site's manifest does not pick up the Snap icons or name", () => {
    const main = readManifest("manifest.json");
    expect(main.short_name).not.toBe("Snap");
    for (const i of main.icons) expect(i.src).not.toContain("/icons/snap/");
  });
});
