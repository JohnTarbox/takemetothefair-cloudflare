/**
 * OPE-849 — a stale form must not blank fields it never loaded.
 *
 * ## The incident this reproduces
 *
 * 2026-09-07 21:03:38, vendor `3dc49a04` ("Zen Kitty Crystal Co."). She set her
 * display name. The same request wrote `""` over description, vendorType,
 * products, contactName, contactEmail, contactPhone, address, city, state and
 * zip. One field set, ten destroyed. `entity_write_log` row `9ef74078` holds
 * the before/after verbatim; her address was still gone a day later.
 *
 * The cause was `buildPayload` returning `{ ...rest }` — every field of
 * `formData`, every save — against a server whose guard is `!== undefined`
 * rather than "is non-empty". A client holding stale state therefore wrote its
 * staleness over newer data, with no version, precondition or dirty tracking
 * anywhere in the path.
 *
 * ## What these tests pin
 *
 * The payload builder is exercised through the real component, because the bug
 * lived in the seam between "what the form loaded" and "what the form sends" —
 * testing the function in isolation would have let that seam keep drifting.
 * The decisive test is `THE WIPE`: it fails on the pre-fix code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import VendorProfilePage from "../page";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "u1", name: "Melissa" } }, status: "authenticated" }),
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

/** The row as it stood AFTER she had entered everything (20:54:11). */
const POPULATED = {
  id: "3dc49a04",
  ownerEmailVerified: true,
  businessName: "Zen Kitty Crystal Co.",
  slug: "zen-kitty-crystal-co",
  description: "Quality Crystals from small Businesses around the world!",
  vendorType: "Crystal and crystal jewelry",
  products: ["Crystals", "crystal jewelry"],
  website: null,
  logoUrl: null,
  contactName: "Melissa Dube",
  contactEmail: "melissamdube22@gmail.com",
  contactPhone: "9789943986",
  address: "50 Highland Street, Apt 4",
  city: "Lowell",
  state: "MA",
  zip: "01852",
  latitude: null,
  longitude: null,
  yearEstablished: null,
  paymentMethods: null,
  licenseInfo: null,
  insuranceInfo: null,
  displayName: null,
  displayMode: null,
};

/** The row as it stood at 20:52:55 — registered, nothing entered yet. */
const EMPTY = {
  ...POPULATED,
  description: null,
  vendorType: null,
  products: [],
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  address: null,
  city: null,
  state: null,
  zip: null,
};

let patchBodies: Array<Record<string, unknown>>;

function mockFetch(getPayload: unknown) {
  patchBodies = [];
  global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes("/api/vendor/profile") && (!init || !init.method || init.method === "GET")) {
      return { ok: true, json: async () => getPayload } as unknown as Response;
    }
    if (init?.method === "PATCH") {
      patchBodies.push(JSON.parse(init.body ?? "{}"));
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  patchBodies = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function renderLoaded(payload: unknown) {
  mockFetch(payload);
  render(<VendorProfilePage />);
  await waitFor(() => expect(screen.getByDisplayValue("Zen Kitty Crystal Co.")).toBeTruthy());
}

function submit() {
  const btn = screen.getByRole("button", { name: /save changes/i });
  fireEvent.click(btn);
}

describe("OPE-849 — THE WIPE: a stale form must not blank what it never loaded", () => {
  it("sends ONLY the field the user changed, not the whole record", async () => {
    // This is the exact shape of the destructive save. The form is loaded from
    // the row as it was BEFORE her data existed (the stale-tab state), then she
    // sets the display name and saves.
    await renderLoaded(EMPTY);

    const displayNameInput = screen.getByRole("textbox", { name: /display name/i });
    fireEvent.change(displayNameInput, {
      target: { name: "displayName", value: "Zen Kitty Crystal Co." },
    });
    submit();

    await waitFor(() => expect(patchBodies.length).toBeGreaterThan(0));
    const body = patchBodies[patchBodies.length - 1];

    // The assertion that fails on the pre-fix code, field by field. Before the
    // fix every one of these was present as "" and the server wrote it.
    for (const field of [
      "description",
      "vendorType",
      "contactName",
      "contactEmail",
      "contactPhone",
      "address",
      "city",
      "state",
      "zip",
    ]) {
      expect(`${field} present=${Object.hasOwn(body, field)}`).toBe(`${field} present=false`);
    }
    expect(Object.hasOwn(body, "products")).toBe(false);

    // ...and the one thing she actually did IS sent.
    expect(body.displayName).toBe("Zen Kitty Crystal Co.");
  });

  it("a save with no edits at all sends no field values", async () => {
    await renderLoaded(POPULATED);
    submit();
    await waitFor(() => expect(patchBodies.length).toBeGreaterThan(0));
    const body = patchBodies[patchBodies.length - 1];
    // Positive landmark: the form really did load 16 populated values, so an
    // empty payload here means "nothing changed", not "nothing was loaded".
    expect(screen.getByDisplayValue("50 Highland Street, Apt 4")).toBeTruthy();
    expect(Object.keys(body)).toHaveLength(0);
  });
});

describe("clearing a field must still work — the fix must not overcorrect", () => {
  it("sends an emptied field, because the user genuinely cleared it", async () => {
    // The failure mode of a careless fix: refuse all blanks and a vendor can
    // never delete their phone number again.
    await renderLoaded(POPULATED);

    const phone = screen.getByDisplayValue("9789943986");
    fireEvent.change(phone, { target: { name: "contactPhone", value: "" } });
    submit();

    await waitFor(() => expect(patchBodies.length).toBeGreaterThan(0));
    const body = patchBodies[patchBodies.length - 1];
    expect(Object.hasOwn(body, "contactPhone")).toBe(true);
    expect(body.contactPhone).toBe("");
    // ...and only that field.
    expect(Object.hasOwn(body, "address")).toBe(false);
  });

  it("sends an edited field with its new value", async () => {
    await renderLoaded(POPULATED);
    const city = screen.getByDisplayValue("Lowell");
    fireEvent.change(city, { target: { name: "city", value: "Boston" } });
    submit();

    await waitFor(() => expect(patchBodies.length).toBeGreaterThan(0));
    const body = patchBodies[patchBodies.length - 1];
    expect(body.city).toBe("Boston");
    expect(Object.hasOwn(body, "state")).toBe(false);
  });
});
