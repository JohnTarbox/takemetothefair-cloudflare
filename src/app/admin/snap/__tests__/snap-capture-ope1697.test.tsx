/**
 * OPE-1697 — replay of 2026-11-21: the phone is at South Portland High School,
 * and two public fairs run that day ~0.2 mi apart. The page used to auto-pin
 * the nearest one silently. Now it must pick NOTHING, refuse to queue a photo
 * until a fair is chosen, remember the choice for the session, and show it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { put } = vi.hoisted(() => ({ put: vi.fn(async (_shot: unknown) => undefined) }));
vi.mock("../snap-queue", () => ({
  SNAP_SYNC_TAG: "snap-flush",
  localDate: () => "2026-11-21",
  newClientId: () => "client-1",
  prepareImage: async () => ({ blob: new Blob(["x"]), thumb: "" }),
  queue: { put, all: async () => [], remove: async () => undefined },
}));

import { SnapCapture } from "../snap-capture";

const MAKERS = {
  id: "31e76477-e49d-4e27-805a-e496e5f6a5e6",
  slug: "makers-market-christmas-arts-craft-show-2026",
  name: "Makers Market Christmas Arts & Craft Show 2026",
  venueName: "South Portland High School",
};
const CHURCH = {
  id: "bf82e162-4cc6-44df-8bf6-8ecefc31cf95",
  slug: "first-light-church-christmas-craft-fair",
  name: "First Light Church Christmas Craft Fair",
  venueName: "First Light Church",
};

function stubFetch(near: Array<typeof MAKERS & { distanceMiles: number }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://x");
      if (u.pathname === "/api/admin/snap/nearby") {
        const located = u.searchParams.has("lat");
        return new Response(
          JSON.stringify({
            events: located
              ? near.map((e) => ({ ...e, atVenue: e.distanceMiles <= 1.5 }))
              : near.map((e) => ({ ...e, distanceMiles: null, atVenue: false })),
          })
        );
      }
      return new Response(JSON.stringify({ statuses: [] }));
    })
  );
}

function stubGeo() {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: vi.fn((ok: PositionCallback) => {
        setTimeout(
          () =>
            ok({
              coords: { latitude: 43.6221, longitude: -70.2684, accuracy: 19 },
              timestamp: Date.now(),
            } as unknown as GeolocationPosition),
          0
        );
        return 7;
      }),
      getCurrentPosition: vi.fn(),
      clearWatch: vi.fn(),
    },
  });
}

async function choose() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(["x"], "booth.jpg", { type: "image/jpeg" })] },
    });
  });
}
const lastMeta = () =>
  (put.mock.calls.at(-1) as unknown as [{ meta: Record<string, unknown> }])[0].meta;

beforeEach(() => {
  put.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  stubGeo();
});
afterEach(() => vi.unstubAllGlobals());

describe("SnapCapture (OPE-1697) — two same-day fairs close by", () => {
  it("picks nothing, blocks the shutter, and sends nothing until a fair is chosen", async () => {
    stubFetch([
      { ...CHURCH, distanceMiles: 0.21 },
      { ...MAKERS, distanceMiles: 0.01 },
    ]);
    render(<SnapCapture />);
    await waitFor(() =>
      expect(screen.getByTestId("snap-location-line").textContent).toBe(
        "2 fairs are close by (±19 m): pick the one you're at"
      )
    );
    expect(screen.getByTestId("snap-target").textContent).toBe(
      "2 fairs are close by: tap to choose"
    );
    expect((screen.getByTestId("snap-shutter") as HTMLButtonElement).disabled).toBe(true);

    // Even a photo that reaches the input (e.g. a share) is not queued.
    await choose();
    expect(put).not.toHaveBeenCalled();

    // The picker opened by itself; choose the right fair.
    fireEvent.click(await screen.findByText(MAKERS.name));
    expect(screen.getByTestId("snap-target").textContent).toBe(
      `${MAKERS.name} @ ${MAKERS.venueName}`
    );
    expect((screen.getByTestId("snap-shutter") as HTMLButtonElement).disabled).toBe(false);
    await choose();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(lastMeta()).toMatchObject({
      eventId: MAKERS.id,
      eventSlug: MAKERS.slug,
      eventChoice: "picked",
    });
  });

  it("one choice covers the session: a remount sends to the remembered fair without asking", async () => {
    stubFetch([
      { ...CHURCH, distanceMiles: 0.21 },
      { ...MAKERS, distanceMiles: 0.01 },
    ]);
    const first = render(<SnapCapture />);
    fireEvent.click(await screen.findByText(MAKERS.name));
    first.unmount();

    render(<SnapCapture />);
    await waitFor(() =>
      expect(screen.getByTestId("snap-target").textContent).toBe(
        `${MAKERS.name} @ ${MAKERS.venueName}`
      )
    );
    await choose();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(lastMeta()).toMatchObject({ eventId: MAKERS.id, eventChoice: "picked" });
  });

  it("a remembered choice older than 4 hours is dropped and the page asks again", async () => {
    stubFetch([
      { ...CHURCH, distanceMiles: 0.21 },
      { ...MAKERS, distanceMiles: 0.01 },
    ]);
    sessionStorage.setItem(
      "snap-pin",
      JSON.stringify({
        choice: { id: MAKERS.id, slug: MAKERS.slug, name: MAKERS.name },
        at: Date.now() - 5 * 60 * 60 * 1000,
      })
    );
    render(<SnapCapture />);
    await waitFor(() =>
      expect(screen.getByTestId("snap-target").textContent).toBe(
        "2 fairs are close by: tap to choose"
      )
    );
  });

  it("one fair close by is auto-selected, SHOWN, and sent as auto_single", async () => {
    stubFetch([{ ...MAKERS, distanceMiles: 0.01 }]);
    render(<SnapCapture />);
    await waitFor(() =>
      expect(screen.getByTestId("snap-target").textContent).toBe(
        `${MAKERS.name} @ ${MAKERS.venueName}`
      )
    );
    await choose();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(lastMeta()).toMatchObject({ eventId: MAKERS.id, eventChoice: "auto_single" });
  });
});
