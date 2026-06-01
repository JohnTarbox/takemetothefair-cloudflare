/**
 * Tests for the IconButton / IconLink primitives.
 *
 * Cohort 5 (2026-06-01). Two key contracts verified at runtime here;
 * the type-level required-aria-label is verified by tsc on every build.
 *   1. aria-label lands on the rendered DOM element (screen readers).
 *   2. Hit area meets WCAG 2.2 AA 2.5.8 (≥ 24px min-w + min-h).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { IconButton } from "../icon-button";

describe("IconButton", () => {
  it("renders with the supplied aria-label on the <button>", () => {
    const { getByRole } = render(<IconButton aria-label="Delete event" icon={<svg />} />);
    const btn = getByRole("button", { name: "Delete event" });
    expect(btn).toBeTruthy();
  });

  it("hides the inner icon from screen readers (icon span has aria-hidden)", () => {
    const { container } = render(<IconButton aria-label="X" icon={<svg data-testid="i" />} />);
    const span = container.querySelector("[aria-hidden='true']");
    expect(span).toBeTruthy();
  });

  it("hit area meets WCAG 2.2 AA 2.5.8 (≥ 24px) for all sizes", () => {
    // The Tailwind class strings are what we actually ship — assert the
    // class strings include the min-w/min-h tokens at our chosen sizes.
    // CSS-pixel measurements are JSDOM-fragile; class assertions are
    // robust and catch the regression that matters (removing the size
    // constraint from the size map).
    for (const size of ["sm", "md", "lg"] as const) {
      const { container } = render(<IconButton aria-label="X" icon={<svg />} size={size} />);
      const btn = container.querySelector("button");
      expect(btn?.className).toMatch(/min-w-\[\d+px\]/);
      expect(btn?.className).toMatch(/min-h-\[\d+px\]/);
      // Parse the actual size out of the class string and verify ≥ 24.
      const widthMatch = btn?.className.match(/min-w-\[(\d+)px\]/);
      const heightMatch = btn?.className.match(/min-h-\[(\d+)px\]/);
      expect(Number(widthMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(24);
      expect(Number(heightMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(24);
    }
  });

  it("defaults type='button' to prevent accidental form submission", () => {
    const { getByRole } = render(<IconButton aria-label="X" icon={<svg />} />);
    const btn = getByRole("button") as HTMLButtonElement;
    expect(btn.type).toBe("button");
  });

  it("forwards click handlers", () => {
    let clicked = false;
    const { getByRole } = render(
      <IconButton
        aria-label="Click me"
        icon={<svg />}
        onClick={() => {
          clicked = true;
        }}
      />
    );
    (getByRole("button") as HTMLButtonElement).click();
    expect(clicked).toBe(true);
  });

  it("forwards disabled state", () => {
    // Separate test so testing-library's shared container doesn't see
    // two buttons (the previous render's button + this one) when
    // getByRole queries.
    const { getByRole } = render(<IconButton aria-label="Disabled" icon={<svg />} disabled />);
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
