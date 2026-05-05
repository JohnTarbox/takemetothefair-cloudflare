import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { VendorTierBadges } from "../VendorTierBadges";

describe("VendorTierBadges", () => {
  it("renders nothing when no badges are active", () => {
    const { container } = render(
      <VendorTierBadges claimed={false} enhancedProfile={false} verifiedPro={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all props are null", () => {
    const { container } = render(
      <VendorTierBadges claimed={null} enhancedProfile={null} verifiedPro={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders only Claimed when claimed=true and others false", () => {
    const { container } = render(
      <VendorTierBadges claimed={true} enhancedProfile={false} verifiedPro={false} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed");
    expect(text).not.toContain("Enhanced");
    expect(text).not.toContain("Verified Pro");
  });

  it("renders only Enhanced when enhanced=true and others false", () => {
    const { container } = render(
      <VendorTierBadges claimed={false} enhancedProfile={true} verifiedPro={false} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Enhanced");
    expect(text).not.toContain("Claimed");
    expect(text).not.toContain("Verified Pro");
  });

  it("renders only Verified Pro when verifiedPro=true and others false", () => {
    const { container } = render(
      <VendorTierBadges claimed={false} enhancedProfile={false} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Verified Pro");
    expect(text).not.toContain("Claimed");
    // "Enhanced" string would be a problem if naively-substring-checked
    // alongside "Verified Pro" — confirm the two are independent.
    expect(text).not.toContain("Enhanced");
  });

  it("renders Claimed + Enhanced in correct order (Claimed before Enhanced)", () => {
    const { container } = render(
      <VendorTierBadges claimed={true} enhancedProfile={true} verifiedPro={false} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed");
    expect(text).toContain("Enhanced");
    expect(text.indexOf("Enhanced")).toBeGreaterThan(text.indexOf("Claimed"));
  });

  it("renders Claimed + Verified Pro (no Enhanced) in correct order", () => {
    const { container } = render(
      <VendorTierBadges claimed={true} enhancedProfile={false} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed");
    expect(text).toContain("Verified Pro");
    expect(text.indexOf("Verified Pro")).toBeGreaterThan(text.indexOf("Claimed"));
  });

  it("renders Enhanced + Verified Pro (no Claimed) in correct order", () => {
    const { container } = render(
      <VendorTierBadges claimed={false} enhancedProfile={true} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Enhanced");
    expect(text).toContain("Verified Pro");
    expect(text.indexOf("Verified Pro")).toBeGreaterThan(text.indexOf("Enhanced"));
  });

  it("renders all three with Claimed → Enhanced → Verified Pro ordering", () => {
    const { container } = render(
      <VendorTierBadges claimed={true} enhancedProfile={true} verifiedPro={true} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed");
    expect(text).toContain("Enhanced");
    expect(text).toContain("Verified Pro");
    expect(text.indexOf("Enhanced")).toBeGreaterThan(text.indexOf("Claimed"));
    expect(text.indexOf("Verified Pro")).toBeGreaterThan(text.indexOf("Enhanced"));
  });
});
