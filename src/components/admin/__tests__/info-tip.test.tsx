/**
 * OPE-1159 — the analytics ⓘ must work without a mouse, and inside a link.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { InfoTip } from "../info-tip";

const LINES = [
  { label: "Measures", text: "Clicks from Google search." },
  { label: "Source", text: "GSC" },
];

function setup(note?: string) {
  const utils = render(<InfoTip title="Google clicks" lines={LINES} note={note} />);
  const button = utils.getByRole("button", { name: "About: Google clicks" });
  const panel = () => document.getElementById(button.getAttribute("aria-describedby")!)!;
  return { ...utils, button, panel };
}

describe("InfoTip", () => {
  afterEach(cleanup);

  it("is a real button whose description is the definition (screen readers get it on focus)", () => {
    const { button, panel } = setup();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(panel()).not.toBeNull();
    expect(panel().getAttribute("role")).toBe("tooltip");
    expect(panel().textContent).toContain("Clicks from Google search.");
  });

  it("opens on keyboard focus and closes on Escape, returning focus", () => {
    const { button, panel } = setup();
    expect(panel().className).toContain("invisible");
    act(() => button.focus());
    expect(panel().className).not.toContain("invisible");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel().className).toContain("invisible");
    expect(document.activeElement).toBe(button);
  });

  it("toggles on tap — there is no hover on a phone", () => {
    const { button, panel } = setup();
    fireEvent.click(button);
    expect(panel().className).not.toContain("invisible");
    fireEvent.click(button);
    expect(panel().className).toContain("invisible");
  });

  it("a tap inside a clickable card does not reach the card's link", () => {
    const onCardClick = vi.fn();
    const { getByRole } = render(
      <div onClick={onCardClick}>
        <InfoTip title="Site health" lines={LINES} />
      </div>
    );
    fireEvent.click(getByRole("button", { name: "About: Site health" }));
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("closes on a tap outside", () => {
    const { button, panel } = setup();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(panel().className).toContain("invisible");
  });

  it("adds the render-state line only when there is one", () => {
    expect(setup().panel().textContent).not.toContain("Now:");
    cleanup();
    expect(setup("a capped sample").panel().textContent).toContain("Now: a capped sample");
  });

  it("is clamped inside the viewport on a phone-width screen", () => {
    Object.defineProperty(window, "innerWidth", { value: 360, configurable: true });
    const { button, panel } = setup();
    button.getBoundingClientRect = () =>
      ({ left: 340, right: 356, top: 10, bottom: 26, width: 16, height: 16 }) as DOMRect;
    fireEvent.click(button);
    const left = parseFloat(panel().style.left);
    const width = parseFloat(panel().style.width);
    expect(width).toBeLessThanOrEqual(360 - 24);
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + width).toBeLessThanOrEqual(360 - 12);
  });
});
