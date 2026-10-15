import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EventGallery } from "../EventGallery";
import Image from "@/components/ui/responsive-image";

/**
 * OPE-1080 — the rendered gallery (and every <Image>) must never ship a
 * srcset whose candidate URLs ignore their width descriptors.
 */

function parseSrcSet(srcset: string): Array<{ url: string; w: number }> {
  return [...srcset.matchAll(/(\S+)\s+(\d+)w(?:,\s*|$)/g)].map((m) => ({
    url: m[1],
    w: Number(m[2]),
  }));
}

const PHOTO =
  "https://cdn.meetmeatthefair.com/events/8f4323d5-213f-4ebf-8a42-71a81fa3cf98/photos/p.webp";

describe("EventGallery thumbnail srcset", () => {
  it("every candidate's width= param equals its descriptor, capped at 1200", () => {
    const { container } = render(
      <EventGallery
        eventName="New Portland Lions Fair"
        images={[
          { id: "a", url: PHOTO, alt: "Midway" },
          { id: "b", url: PHOTO.replace("p.webp", "q.webp"), alt: "Barn", rotation: 90 },
        ]}
      />
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      const cands = parseSrcSet(img.getAttribute("srcset") ?? "");
      expect(cands.map((c) => c.w)).toEqual([400, 800, 1200]);
      for (const c of cands) {
        expect(c.url).toMatch(
          new RegExp(`/cdn-cgi/image/width=${c.w},height=${Math.round((c.w * 2) / 3)},`)
        );
      }
      expect(new Set(cands.map((c) => c.url)).size).toBe(3);
      // CLS + lazy rules
      expect(img.getAttribute("width")).toBe("800");
      expect(img.getAttribute("height")).toBe("533");
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("sizes")).toBeTruthy();
    }
    expect(imgs[1].getAttribute("srcset")).toContain("rotate=90");
  });

  it("a hotlinked gallery photo gets a single src and NO srcset", () => {
    const { container } = render(
      <EventGallery
        eventName="x"
        images={[{ id: "a", url: "https://www.jotform.com/uploads/x/logo.png", alt: "Logo" }]}
      />
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://www.jotform.com/uploads/x/logo.png");
    expect(img.hasAttribute("srcset")).toBe(false);
  });
});

describe("responsive-image wrapper (every <Image> in the app)", () => {
  it.each([
    ["foreign hotlink", "https://images.humanitix.com/i/abc@seo-500.jpg"],
    [
      "pre-transformed cdn-cgi URL",
      `https://meetmeatthefair.com/cdn-cgi/image/width=600,height=400,fit=cover,gravity=auto,format=auto/${PHOTO}`,
    ],
  ])("%s → no srcset", (_label, src) => {
    const { container } = render(<Image src={src} alt="x" width={300} height={200} />);
    const img = container.querySelector("img")!;
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(img.getAttribute("src")).toBe(src);
  });

  it("a resizable cdn source keeps next/image's srcset", () => {
    const { container } = render(<Image src={PHOTO} alt="x" width={300} height={200} />);
    expect(container.querySelector("img")!.getAttribute("srcset")).toBeTruthy();
  });
});

describe("sweep — no direct next/image import, no hand-rolled srcset", () => {
  const root = join(__dirname, "../../..");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "__tests__" || name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  })(root);

  it("finds the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('only src/components/ui/responsive-image.tsx imports "next/image"', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith(join("ui", "responsive-image.tsx")) &&
        /from\s+["']next\/image["']/.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("no file hand-builds a `<url> ${w}w` srcset outside cdnSrcSet", () => {
    // The two pre-OPE-1080 shapes: `${cdnImage(...)} ${w}w` and
    // `${url} ${widths[i]}w`. Both bypass cdnSrcSet's descriptor check.
    const handRolled = /\}\s\$\{(?:w|\w+\[i\])\}w`/;
    const offenders = files.filter(
      (f) => !f.endsWith(join("lib", "cdn-image.ts")) && handRolled.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
