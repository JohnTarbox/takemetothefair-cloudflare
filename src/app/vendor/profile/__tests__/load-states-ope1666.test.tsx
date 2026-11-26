/**
 * OPE-1666 — what `/vendor/profile` shows for each outcome of its one load.
 *
 * The page renders the form (and with it the logo control) only after
 * `GET /api/vendor/profile` returns 200 and the form is seeded. Every other
 * outcome renders NO fields. These tests pin which notice each outcome gets,
 * and that the logo upload control is really rendered on success.
 *
 * The defect fixed here: a 500 (the route's catch — a D1 overload, say) fell
 * through to the "No vendor profile found. Please contact support." branch,
 * telling a vendor who has a profile that she has none.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import VendorProfilePage from "../page";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "u1", name: "Pat" } }, status: "authenticated" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/vendors/gallery/VendorGalleryLoader", () => ({
  VendorGalleryLoader: () => null,
}));
vi.mock("@/components/vendor/claim-widget", () => ({ VendorClaimWidget: () => null }));
vi.mock("@/components/vendor/SelfReportedFairsEditor", () => ({
  SelfReportedFairsEditor: () => null,
}));
vi.mock("@/components/onboarding/welcome-banner", () => ({ WelcomeBanner: () => null }));
vi.mock("@/components/google-place-search", () => ({ GooglePlaceSearch: () => null }));
vi.mock("@/components/auth/ResendVerificationButton", () => ({
  ResendVerificationButton: () => null,
}));

const PROFILE = {
  id: "v1",
  ownerEmailVerified: true,
  businessName: "Example Pottery",
  slug: "example-pottery",
  description: null,
  vendorType: null,
  products: "[]",
  website: null,
  logoUrl: null,
  verified: false,
  claimed: true,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  address: null,
  city: null,
  state: "ME",
  zip: null,
  latitude: null,
  longitude: null,
  yearEstablished: null,
  paymentMethods: null,
  licenseInfo: null,
  insuranceInfo: null,
  displayName: null,
  displayMode: null,
  role: null,
  displayOverridePermitted: null,
};

const NOT_FOUND = /No vendor profile found/;
const LOAD_FAILED = /We couldn.t load your profile/;

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

describe("OPE-1666 — /vendor/profile load outcomes", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("200 → the form loads with the vendor's data AND the logo upload control", async () => {
    respondWith(200, PROFILE);
    render(<VendorProfilePage />);
    expect(await screen.findByDisplayValue("Example Pottery")).toBeTruthy();
    expect(screen.getByText("Upload logo")).toBeTruthy();
    const file = document.querySelector('input[type="file"][accept*="image/png"]');
    expect(file).not.toBeNull();
  });

  it("500 → the failed-read notice, NOT 'no vendor profile found'", async () => {
    respondWith(500, { error: "Failed to fetch profile" });
    render(<VendorProfilePage />);
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
    expect(screen.queryByText("Upload logo")).toBeNull();
  });

  it("404 → 'no vendor profile found' (the account really has no vendor row)", async () => {
    respondWith(404, { error: "Vendor profile not found" });
    render(<VendorProfilePage />);
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
  });

  it("a network error → the failed-read notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    render(<VendorProfilePage />);
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
  });
});
