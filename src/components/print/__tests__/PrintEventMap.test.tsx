/**
 * Image alt regression (OPE-44 / Bing on-page nit "img missing alt").
 *
 * PrintEventMap is the simplest meaningful-image component in the tree, so
 * it's used here as the guard that a fixed/rendered <img> always carries a
 * non-empty, descriptive alt (never undefined / empty on a content image).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PrintEventMap } from "../PrintEventMap";

describe("PrintEventMap", () => {
  it("renders an <img> with a non-empty, descriptive alt", () => {
    const { container } = render(
      <PrintEventMap latitude={44.1} longitude={-70.2} venueName="Fryeburg Fairgrounds" />
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const alt = img?.getAttribute("alt");
    // Present, non-empty, and derived from the venue (meaningful image).
    expect(alt).toBeTruthy();
    expect(alt).toContain("Fryeburg Fairgrounds");
  });
});
