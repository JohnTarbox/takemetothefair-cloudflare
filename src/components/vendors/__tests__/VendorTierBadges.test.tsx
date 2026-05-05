import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { VendorTierBadges } from "../VendorTierBadges";

describe("VendorTierBadges", () => {
  it("renders nothing when neither claimed nor enhanced", () => {
    const { container } = render(<VendorTierBadges claimed={false} enhancedProfile={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when both props are null", () => {
    const { container } = render(<VendorTierBadges claimed={null} enhancedProfile={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders only Claimed when claimed=true and enhanced=false", () => {
    const { container } = render(<VendorTierBadges claimed={true} enhancedProfile={false} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed");
    expect(text).not.toContain("Enhanced");
  });

  it("renders only Enhanced when enhanced=true and claimed=false", () => {
    const { container } = render(<VendorTierBadges claimed={false} enhancedProfile={true} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Enhanced");
    expect(text).not.toContain("Claimed");
  });

  it("renders both badges when both true, with Claimed before Enhanced", () => {
    const { container } = render(<VendorTierBadges claimed={true} enhancedProfile={true} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed");
    expect(text).toContain("Enhanced");
    expect(text.indexOf("Enhanced")).toBeGreaterThan(text.indexOf("Claimed"));
  });
});
