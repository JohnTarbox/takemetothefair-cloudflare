/**
 * OPE-1401 — lucide-react 1.x dropped brand icons; before this, nothing
 * rendered ShareButtons, so a missing export would only have crashed at
 * runtime. This renders the real menu and checks every item.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ShareButtons } from "@/components/ShareButtons";

vi.mock("@/lib/analytics", () => ({ trackShare: vi.fn() }));

describe("ShareButtons (OPE-1401, lucide 1.x)", () => {
  it("opens the menu with all five items labelled, each with a decorative icon", () => {
    render(
      <ShareButtons
        url="https://meetmeatthefair.com/events/x"
        title="X Fair"
        entityType="EVENT"
        entityId="e1"
        entitySlug="x"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Share X Fair" }));
    for (const name of [
      "Share on Twitter",
      "Share on Facebook",
      "Share on LinkedIn",
      "Share via email",
      "Copy link to clipboard",
    ]) {
      const item = screen.getByRole("menuitem", { name });
      const svg = item.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
      // The brand marks keep lucide 0.563's 24-unit stroke geometry.
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    }
  });
});
