/**
 * OPE-686 — the in-page confirmation that replaces `window.confirm`.
 *
 * The contract that matters is not cosmetic. A native dialog blocks the
 * renderer's main thread, which on 2026-08-31 froze the Chrome extension
 * outright: `Input.dispatchMouseEvent` timed out after 30s and every
 * subsequent screenshot failed, leaving a human to click OK by hand. So:
 * the destructive action must need two clicks, and both must be ordinary DOM
 * buttons an automated caller can find and press.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ConfirmButton } from "../confirm-button";

describe("ConfirmButton", () => {
  it("does not fire on the first click", async () => {
    const onConfirm = vi.fn();
    const { getByRole } = render(
      <ConfirmButton onConfirm={onConfirm} aria-label="Delete photo">
        x
      </ConfirmButton>
    );
    fireEvent.click(getByRole("button", { name: "Delete photo" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("fires on the second click, on a real button", async () => {
    // getByRole is exactly how an automated caller finds it. A native
    // confirm() has no role, no name and no element — which is why the
    // extension had nothing to click.
    const onConfirm = vi.fn();
    const { getByRole } = render(
      <ConfirmButton onConfirm={onConfirm} aria-label="Delete photo" confirmLabel="Delete">
        x
      </ConfirmButton>
    );
    fireEvent.click(getByRole("button", { name: "Delete photo" }));
    fireEvent.click(getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels without firing, and can be armed again", () => {
    const onConfirm = vi.fn();
    const { getByRole } = render(
      <ConfirmButton onConfirm={onConfirm} aria-label="Delete photo">
        x
      </ConfirmButton>
    );
    fireEvent.click(getByRole("button", { name: "Delete photo" }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    // Back to the initial state rather than stuck disarmed.
    expect(getByRole("button", { name: "Delete photo" })).toBeTruthy();
  });

  it("disarms on Escape", () => {
    const onConfirm = vi.fn();
    const { getByRole, getByLabelText } = render(
      <ConfirmButton onConfirm={onConfirm} aria-label="Delete photo" prompt="Delete?">
        x
      </ConfirmButton>
    );
    fireEvent.click(getByRole("button", { name: "Delete photo" }));
    fireEvent.keyDown(getByLabelText("Delete?"), { key: "Escape" });
    expect(getByRole("button", { name: "Delete photo" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("moves focus to the confirm button when armed", () => {
    // Without this the keyboard user is left on an element that no longer
    // exists, and has to hunt for the confirmation.
    const { getByRole } = render(
      <ConfirmButton onConfirm={() => {}} aria-label="Delete photo" confirmLabel="Delete">
        x
      </ConfirmButton>
    );
    fireEvent.click(getByRole("button", { name: "Delete photo" }));
    expect(document.activeElement).toBe(getByRole("button", { name: "Delete" }));
  });

  it("honours disabled on the trigger", () => {
    const onConfirm = vi.fn();
    const { getByRole } = render(
      <ConfirmButton onConfirm={onConfirm} aria-label="Delete photo" disabled>
        x
      </ConfirmButton>
    );
    fireEvent.click(getByRole("button", { name: "Delete photo" }));
    expect(onConfirm).not.toHaveBeenCalled();
    // Still the trigger — a disabled control must not arm.
    expect(getByRole("button", { name: "Delete photo" })).toBeTruthy();
  });
});
