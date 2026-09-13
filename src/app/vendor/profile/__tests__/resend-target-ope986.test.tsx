/**
 * OPE-986 — the unverified-vendor resend button must not offer an email box
 * the API ignores.
 *
 * `ResendVerificationButton` without an `email` prop renders an address input
 * (it was built for the signed-out /verify-email/resend page). On the vendor
 * profile the caller is always signed in, and /api/auth/send-verification
 * prefers the SESSION address over the body. So a vendor who registered with a
 * typo and typed the corrected address into that box was told "a fresh
 * verification link is on its way" — and it went to the typo again.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import VendorProfilePage from "../page";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "u1", name: "Douglas" } }, status: "authenticated" }),
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

const UNVERIFIED = {
  id: "d4b29175",
  ownerEmailVerified: false,
  ownerEmail: "sanzaart@gmail.com",
  businessName: "Sanza Studio Creations",
  slug: "sanza-studio-creations",
  description: null,
  vendorType: null,
  products: [],
  website: null,
  logoUrl: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  address: null,
  city: null,
  state: null,
  zip: null,
  latitude: null,
  longitude: null,
  yearEstablished: null,
  paymentMethods: null,
  licenseInfo: null,
  insuranceInfo: null,
  displayName: null,
  displayMode: null,
};

let resendBodies: string[];

function mockFetch(payload: unknown) {
  resendBodies = [];
  global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes("/api/auth/send-verification")) {
      resendBodies.push(init?.body ?? "");
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (u.includes("/api/vendor/profile")) {
      return { ok: true, json: async () => payload } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OPE-986 — resend on the vendor profile goes to the account address, visibly", () => {
  it("renders no email box, and the resend request carries no typed address", async () => {
    mockFetch(UNVERIFIED);
    render(<VendorProfilePage />);
    await waitFor(() => expect(screen.getByDisplayValue("Sanza Studio Creations")).toBeTruthy());

    expect(screen.getByText(/won.t save until you verify your email/i)).toBeTruthy();
    // The box that silently did nothing.
    expect(screen.queryByRole("textbox", { name: /your email address/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /resend verification email/i }));
    await waitFor(() => expect(resendBodies).toHaveLength(1));
    expect(JSON.parse(resendBodies[0])).toEqual({});
  });
});
