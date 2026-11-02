/**
 * OPE-1549 — the queued shot's `meta` (what the upload carries) for both
 * acceptance paths: location allowed → lat/lng/accuracy; location blocked →
 * the screen says so, the fair is picked by hand, and `eventId`/`eventSlug`
 * travel with the shot. IndexedDB, the image pipeline and the service worker
 * are stubbed; geolocation and fetch are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { put } = vi.hoisted(() => ({ put: vi.fn(async (_shot: unknown) => undefined) }));
vi.mock("../snap-queue", () => ({
  SNAP_SYNC_TAG: "snap-flush",
  localDate: () => "2026-11-01",
  newClientId: () => "client-1",
  prepareImage: async () => ({ blob: new Blob(["x"]), thumb: "" }),
  queue: { put, all: async () => [], remove: async () => undefined },
}));

import { SnapCapture } from "../snap-capture";

const HARVEST = {
  id: "d9b44d1c-e349-4d41-b797-7e232c06d521",
  slug: "harvest-festival-of-crafts-2026",
  name: "Harvest Festival of Crafts 2026",
  venueName: "Augusta Armory · Augusta, ME",
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://x");
      if (u.pathname === "/api/admin/snap/nearby") {
        const located = u.searchParams.has("lat");
        return new Response(
          JSON.stringify({
            events: [
              located
                ? { ...HARVEST, distanceMiles: 0.01, atVenue: true }
                : { ...HARVEST, distanceMiles: null, atVenue: false },
            ],
          })
        );
      }
      return new Response(JSON.stringify({ statuses: [] }));
    })
  );
}

type Geo = {
  watchPosition: ReturnType<typeof vi.fn>;
  getCurrentPosition: ReturnType<typeof vi.fn>;
  clearWatch: ReturnType<typeof vi.fn>;
};
function stubGeo(behave: "allow" | "deny"): Geo {
  const geo: Geo = {
    watchPosition: vi.fn((ok: PositionCallback, err: PositionErrorCallback) => {
      setTimeout(() => {
        if (behave === "allow") {
          ok({
            coords: { latitude: 44.3106, longitude: -69.7795, accuracy: 19 },
            timestamp: Date.now(),
          } as unknown as GeolocationPosition);
        } else {
          err({ code: 1, PERMISSION_DENIED: 1, message: "denied" } as GeolocationPositionError);
        }
      }, 0);
      return 7;
    }),
    getCurrentPosition: vi.fn(),
    clearWatch: vi.fn(),
  };
  Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
  return geo;
}

async function snapOne() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["x"], "booth.jpg", { type: "image/jpeg" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await waitFor(() => expect(put).toHaveBeenCalled());
  return (put.mock.calls[0] as unknown as [{ meta: Record<string, unknown> }])[0].meta;
}

beforeEach(() => {
  put.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("SnapCapture (OPE-1549)", () => {
  it("location allowed: the line says where, and the shot carries lat/lng/accuracy + the at-venue pin", async () => {
    stubGeo("allow");
    render(<SnapCapture />);
    await waitFor(() =>
      expect(screen.getByTestId("snap-location-line").textContent).toBe(
        "You're at: Harvest Festival of Crafts 2026 (±19 m)"
      )
    );
    const meta = await snapOne();
    expect(meta).toMatchObject({
      latitude: 44.3106,
      longitude: -69.7795,
      accuracyM: 19,
      eventId: HARVEST.id,
      eventSlug: HARVEST.slug,
    });
  });

  it("location blocked: the line says so, today's list still loads, and a hand pin travels as eventId", async () => {
    const geo = stubGeo("deny");
    render(<SnapCapture />);
    const line = await screen.findByText("Location blocked: tap to fix");
    // Tapping retries the request and shows how to allow it.
    fireEvent.click(line);
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Site settings/)).toBeTruthy();

    fireEvent.click(screen.getByText("Tap to pick the fair"));
    fireEvent.click(await screen.findByText(HARVEST.name));
    const meta = await snapOne();
    expect(meta).toMatchObject({
      latitude: null,
      longitude: null,
      eventId: HARVEST.id,
      eventSlug: HARVEST.slug,
    });
  });
});
