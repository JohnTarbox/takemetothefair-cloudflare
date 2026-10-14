/**
 * OPE-364 (2026-10-14) — the claim WIZARD emits the four D1 claim-funnel steps.
 *
 * Before this, the wizard at /claim/<type>/<slug> — the path every claimant
 * without an email match takes — sent GA4 `_server` events only. Prod held
 * 23 `claim_view`, 13 `claim_form_interacted` and ZERO `claim_started` /
 * `claim_submitted` rows, ever: the funnel read as total drop-off at `started`.
 *
 * The server REJECTS every claim here, so `submitted` is proven to fire on the
 * attempt (John's 1a ruling), and the step counts are asserted exactly, because
 * the read path compares adjacent steps by count — a duplicate is a wrong ratio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const beacons: string[] = [];
vi.mock("@/lib/analytics", () => ({
  trackClaimView: (_t: string, _s: string, surface?: string) =>
    beacons.push(`claim_view:${surface ?? "-"}`),
  trackFunnelInteracted: (funnel: string) => beacons.push(`${funnel}_form_interacted`),
  trackClaimStep: (stage: string, _t: string, _s: string, surface: string) =>
    beacons.push(`claim_${stage}:${surface}`),
}));

import { ClaimWizard } from "../ClaimWizard";
import { ClaimEvidenceForm } from "../ClaimEvidenceForm";

function wizard(isLoggedIn = true) {
  return render(
    <ClaimWizard
      entityType="VENDOR"
      slug="acme"
      entityName="Acme"
      viewCount={3}
      linkedEventsCount={1}
      isLoggedIn={isLoggedIn}
      registerHref="/register?claim=acme"
      loginHref="/login"
    />
  );
}

beforeEach(() => {
  beacons.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "rejected" }), { status: 409 }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("OPE-364 — claim wizard emits every claim-funnel step", () => {
  it("view → interacted → started → submitted, once each, submitted on a REJECTED attempt", async () => {
    wizard();
    fireEvent.click(screen.getByRole("button", { name: /continue/i })); // preview → account
    fireEvent.click(screen.getByRole("button", { name: /continue/i })); // account → verify
    fireEvent.click(screen.getByRole("button", { name: /check my claim/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(beacons).toEqual([
      "claim_view:wizard",
      "claim_form_interacted",
      "claim_started:wizard",
      "claim_submitted:wizard",
    ]);
  });

  it("Back/Continue loops and a retry do not double-count any step", async () => {
    wizard();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i })); // verify → account
    fireEvent.click(screen.getByRole("button", { name: /continue/i })); // account → verify again
    fireEvent.click(screen.getByRole("button", { name: /check my claim/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /check my claim/i })); // retry
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    const counts = beacons.reduce<Record<string, number>>(
      (m, b) => ((m[b] = (m[b] ?? 0) + 1), m),
      {}
    );
    expect(counts).toEqual({
      "claim_view:wizard": 1,
      claim_form_interacted: 1,
      "claim_started:wizard": 1,
      "claim_submitted:wizard": 1,
    });
  });

  it("signed out: view and interacted fire, started does not (no Verify step reachable)", () => {
    wizard(false);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(beacons).toEqual(["claim_view:wizard", "claim_form_interacted"]);
  });
});

describe("OPE-364 — evidence form", () => {
  it("standalone: started on first keystroke, submitted on a REJECTED attempt", async () => {
    render(<ClaimEvidenceForm entityType="PERFORMER" slug="band" entityName="Band" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "I" } });
    fireEvent.change(box, { target: { value: "I run it" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(beacons).toEqual(["claim_started:evidence", "claim_submitted:evidence"]);
  });

  it("inside the wizard: silent, so one claim is not counted twice", async () => {
    render(<ClaimEvidenceForm entityType="VENDOR" slug="acme" entityName="Acme" inWizard />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "I own it" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(beacons).toEqual([]);
  });
});
