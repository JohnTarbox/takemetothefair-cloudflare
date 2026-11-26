/**
 * OPE-1548 — PasswordInput: the optional show/hide toggle on every password
 * field in the main app (/login, /register, /reset-password/[token]).
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PasswordInput } from "../password-input";

function setup(props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) {
  const utils = render(
    <form data-testid="form">
      <PasswordInput label="Password" defaultValue="hunter2" {...props} />
    </form>
  );
  const input = utils.getByLabelText("Password") as HTMLInputElement;
  const toggle = utils.getByRole("button", { name: "Show password" });
  return { ...utils, input, toggle };
}

describe("PasswordInput (OPE-1548)", () => {
  it("is hidden by default, with the toggle not pressed", () => {
    const { input, toggle } = setup();
    expect(input.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles password → text → password and flips aria-pressed", () => {
    const { input, toggle } = setup();
    fireEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(input.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("the toggle is type=button and never submits the form", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    const { toggle, getByTestId } = setup();
    getByTestId("form").addEventListener("submit", onSubmit);
    expect(toggle.getAttribute("type")).toBe("button");
    fireEvent.click(toggle);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("aria-controls names the input, and the label is associated even with no id/name", () => {
    const { input, toggle } = setup();
    expect(input.id).toBeTruthy();
    expect(toggle.getAttribute("aria-controls")).toBe(input.id);
  });

  it("keeps focus and the caret in the field when toggled from inside it", () => {
    const { input, toggle } = setup();
    input.focus();
    input.setSelectionRange(3, 3);
    // jsdom keeps the caret across a `type` change; some real engines reset
    // it (and can drop focus). Simulate that hostile engine: the field must
    // still end focused with the caret where it was. What carries that is the
    // input being STILL FOCUSED at commit (pointerdown prevented, asserted
    // below), which lets React's commit-phase selection restore put it back.
    const realSetAttribute = input.setAttribute.bind(input);
    input.setAttribute = ((name: string, value: string) => {
      realSetAttribute(name, value);
      if (name === "type") {
        input.setSelectionRange(0, 0);
        input.blur();
      }
    }) as typeof input.setAttribute;
    // A tap: pointerdown is prevented so the input never blurs.
    const down = fireEvent.pointerDown(toggle);
    expect(down).toBe(false); // preventDefault() was called
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
  });

  it("a fresh mount is hidden again (the choice is never remembered)", () => {
    const first = setup();
    fireEvent.click(first.toggle);
    expect(first.input.type).toBe("text");
    first.unmount();
    const second = setup();
    expect(second.input.type).toBe("password");
  });

  it("defaults autocomplete to current-password and passes new-password through", () => {
    expect(setup().input.getAttribute("autocomplete")).toBe("current-password");
    const { getByLabelText } = render(<PasswordInput label="New" autoComplete="new-password" />);
    expect(getByLabelText("New").getAttribute("autocomplete")).toBe("new-password");
  });

  it("the toggle's tap target is at least 44×44 (h-11 w-11)", () => {
    const { toggle } = setup();
    expect(toggle.className).toMatch(/\bh-11\b/);
    expect(toggle.className).toMatch(/\bw-11\b/);
  });
});
