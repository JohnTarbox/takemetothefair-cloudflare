/**
 * OPE-364 (1a, John 2026-09-30) — `claim_submitted` fires on the ATTEMPT.
 *
 * It used to fire only after the claim API returned ok, so a claim endpoint
 * rejecting every request read as "nobody tried", and the step could not be
 * demonstrated without creating a real claim. Each test here makes the server
 * REJECT the claim and asserts the step still fired — the one case the old code
 * got wrong — and that `approved` (a success-only step) did not.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const trackVendorClaim = vi.fn();
vi.mock("@/lib/analytics", () => ({
  trackVendorClaim: (...args: unknown[]) => trackVendorClaim(...args),
  trackFormSubmit: vi.fn(),
}));
let sessionEmail = "owner@example.org";
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", email: sessionEmail } },
    status: "authenticated",
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/vendor/profile",
}));

import { DirectClaimButton } from "@/components/vendors/DirectClaimButton";
import { VendorClaimWidget } from "../claim-widget";

function stages() {
  return trackVendorClaim.mock.calls.map((c) => `${c[0]}:${c[1]}`);
}

beforeEach(() => {
  trackVendorClaim.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "rejected" }), { status: 409 }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("OPE-364 claim_submitted fires on the attempt, not on success", () => {
  it("DirectClaimButton — rejected claim still records submitted, never approved", async () => {
    render(<DirectClaimButton vendorSlug="acme" vendorId="v1" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(stages()).toEqual(["started:register", "submitted:register"]);
  });

  it("claim widget, direct path — rejected claim still records submitted", async () => {
    sessionEmail = "owner@example.org";
    render(
      <VendorClaimWidget
        claimed={false}
        vendorId="v1"
        vendorSlug="acme"
        vendorContactEmail="owner@example.org"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /claim this listing now/i }));
    await waitFor(() => expect(screen.getByText(/rejected/)).toBeTruthy());
    expect(stages()).toEqual(["started:register", "submitted:register"]);
  });

  it("claim widget, email path — rejected initiate still records submitted", async () => {
    sessionEmail = "someone-else@example.org";
    render(
      <VendorClaimWidget
        claimed={false}
        vendorId="v1"
        vendorSlug="acme"
        vendorContactEmail="owner@example.org"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /send me a confirmation email/i }));
    await waitFor(() => expect(screen.getByText(/rejected/)).toBeTruthy());
    expect(stages()).toEqual(["started:email", "submitted:email"]);
  });
});
