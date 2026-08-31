import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { VendorTierBadges } from "../VendorTierBadges";

describe("VendorTierBadges", () => {
  it("renders nothing when no badges are active", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={false} enhancedProfile={false} verifiedPro={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all props are null", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={null} enhancedProfile={null} verifiedPro={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders only Owner-confirmed when claimed=true and others false", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={true} enhancedProfile={false} verifiedPro={false} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Owner-confirmed");
    expect(text).not.toContain("Enhanced");
    expect(text).not.toContain("Verified Pro");
  });

  it("renders only Enhanced when enhanced=true and others false", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={false} enhancedProfile={true} verifiedPro={false} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Enhanced");
    expect(text).not.toContain("Owner-confirmed");
    expect(text).not.toContain("Verified Pro");
  });

  it("renders only Verified Pro when verifiedPro=true and others false", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={false} enhancedProfile={false} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Verified Pro");
    expect(text).not.toContain("Owner-confirmed");
    // "Enhanced" string would be a problem if naively-substring-checked
    // alongside "Verified Pro" — confirm the two are independent.
    expect(text).not.toContain("Enhanced");
  });

  it("renders Owner-confirmed + Enhanced in correct order (Owner-confirmed before Enhanced)", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={true} enhancedProfile={true} verifiedPro={false} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Owner-confirmed");
    expect(text).toContain("Enhanced");
    expect(text.indexOf("Enhanced")).toBeGreaterThan(text.indexOf("Owner-confirmed"));
  });

  it("renders Owner-confirmed + Verified Pro (no Enhanced) in correct order", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={true} enhancedProfile={false} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Owner-confirmed");
    expect(text).toContain("Verified Pro");
    expect(text.indexOf("Verified Pro")).toBeGreaterThan(text.indexOf("Owner-confirmed"));
  });

  it("renders Enhanced + Verified Pro (no Owner-confirmed) in correct order", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={false} enhancedProfile={true} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Enhanced");
    expect(text).toContain("Verified Pro");
    expect(text.indexOf("Verified Pro")).toBeGreaterThan(text.indexOf("Enhanced"));
  });

  it("renders all three with Owner-confirmed → Enhanced → Verified Pro ordering", () => {
    const { container } = render(
      <VendorTierBadges ownerConfirmed={true} enhancedProfile={true} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Owner-confirmed");
    expect(text).toContain("Enhanced");
    expect(text).toContain("Verified Pro");
    expect(text.indexOf("Enhanced")).toBeGreaterThan(text.indexOf("Owner-confirmed"));
    expect(text.indexOf("Verified Pro")).toBeGreaterThan(text.indexOf("Enhanced"));
  });
});
