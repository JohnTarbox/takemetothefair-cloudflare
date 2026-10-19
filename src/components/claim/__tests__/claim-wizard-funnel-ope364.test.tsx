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
import { render, renderHook, screen, fireEvent, waitFor } from "@testing-library/react";

const beacons: string[] = [];
const triggers: string[] = [];
vi.mock("@/lib/analytics", () => ({
  trackClaimView: (_t: string, _s: string, surface?: string, trigger?: string) => {
    beacons.push(`claim_view:${surface ?? "-"}`);
    triggers.push(trigger ?? "-");
  },
  trackFunnelInteracted: (funnel: string) => beacons.push(`${funnel}_form_interacted`),
  trackClaimStep: (stage: string, _t: string, _s: string, surface: string) =>
    beacons.push(`claim_${stage}:${surface}`),
}));

import { ClaimWizard } from "../ClaimWizard";
import { ClaimEvidenceForm } from "../ClaimEvidenceForm";
import {
  HUMAN_INTERACTION_EVENTS,
  RENDERER_PRODUCIBLE_EVENTS,
  useOnFirstHumanInteraction,
} from "@/lib/hooks/use-first-human-interaction";

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
  triggers.length = 0;
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

// OPE-364 rework — claim_view fired ON MOUNT, so every JS-rendering crawler
// walking /claim/* recorded one: 23 rows all-time became 282 in ~13h
// (2026-10-14 23:41Z → 10-15), each a different vendor slug, nearly all desktop.
describe("OPE-364 rework — claim_view waits for a human", () => {
  it("render alone (what a crawler does) emits NO claim_view", async () => {
    wizard();
    await new Promise((r) => setTimeout(r, 0));
    expect(beacons).toEqual([]);
  });

  it.each(HUMAN_INTERACTION_EVENTS)("first %s emits exactly one claim_view", (type) => {
    wizard();
    window.dispatchEvent(new Event(type));
    window.dispatchEvent(new Event(type));
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));
    expect(beacons).toEqual(["claim_view:wizard"]);
    expect(triggers).toEqual([type]);
  });

  // The 10-16 cut admitted `scroll` and `focusin`, and the crawler kept coming:
  // 382 / 55 / 196 claim_view rows on 10-16 → 10-18, each a different vendor,
  // zero later steps. A renderer produces both without a human.
  it.each(RENDERER_PRODUCIBLE_EVENTS)(
    "%s alone (a renderer can produce it) emits NO claim_view",
    (type) => {
      wizard();
      window.dispatchEvent(new Event(type));
      expect(beacons).toEqual([]);
    }
  );

  it("the two lists are disjoint, and the human list is non-empty", () => {
    expect(HUMAN_INTERACTION_EVENTS.length).toBeGreaterThan(0);
    for (const t of RENDERER_PRODUCIBLE_EVENTS) {
      expect(HUMAN_INTERACTION_EVENTS as readonly string[]).not.toContain(t);
    }
  });

  it("Continue without a prior input records trigger 'direct'", () => {
    wizard();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(triggers).toEqual(["direct"]);
  });

  it("a press on a control inside the page counts (capture phase, not only window targets)", () => {
    wizard();
    fireEvent.pointerDown(screen.getByRole("button", { name: /continue/i }));
    expect(beacons).toEqual(["claim_view:wizard"]);
  });

  it("interaction then Continue: view still fires once, and before interacted", () => {
    wizard();
    window.dispatchEvent(new Event("wheel"));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(beacons).toEqual(["claim_view:wizard", "claim_form_interacted"]);
  });

  it("the hook removes its listeners on unmount — no fire after the page is gone", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useOnFirstHumanInteraction(cb));
    unmount();
    window.dispatchEvent(new Event("pointerdown"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("the hook's fire() and a later interaction share one guard", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useOnFirstHumanInteraction(cb));
    result.current();
    result.current();
    window.dispatchEvent(new Event("keydown"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
