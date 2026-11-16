/**
 * OPE-1630 item 3 — the /admin/feed-review actions.
 *
 * The route's refusals each have one reviewer answer; the component must offer
 * it as a retry that carries the original request plus exactly that answer —
 * never a guess, never a dropped field.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { FeedItemReviewActions, refusalChoices } from "../FeedItemReviewActions";
import { parseReviewState } from "@/app/admin/feed-review/page";

const SUGGEST = {
  action: "link" as const,
  event_id: "ev-1",
  event_name: "Bath Spirit of Christmas Fair 2026",
  event_slug: "bath-spirit",
};

describe("refusalChoices", () => {
  it("offers each venue candidate as a venue_id retry of the same request", () => {
    const sent = { action: "approve_as_occurrence" as const, series_id: "s-1", note: "n" };
    const choices = refusalChoices(sent, {
      ok: false,
      code: "venue_unmatched",
      venue_candidates: [
        { id: "v-1", name: "Boothbay Railway Village Museum", city: "Boothbay", state: "ME" },
        { id: "v-2", name: "Railway Hall", city: null, state: null },
      ],
    });
    expect(choices.map((c) => c.body)).toEqual([
      { ...sent, venue_id: "v-1" },
      { ...sent, venue_id: "v-2" },
    ]);
    expect(choices[0].label).toBe("Use venue: Boothbay Railway Village Museum, Boothbay ME");
  });

  it("offers link-instead and a not_duplicate_of override for that one match", () => {
    const sent = { action: "approve" as const, venue_id: "v-9" };
    const choices = refusalChoices(sent, { ok: false, code: "duplicate", suggest: SUGGEST });
    expect(choices.map((c) => c.body)).toEqual([
      { action: "link", event_id: "ev-1", note: undefined },
      { action: "approve", venue_id: "v-9", not_duplicate_of: "ev-1" },
    ]);
  });

  it("treats a match another organizer manages the same way", () => {
    const choices = refusalChoices(
      { action: "approve" },
      { ok: false, code: "listed_by_another_organizer", suggest: SUGGEST }
    );
    expect(choices).toHaveLength(2);
  });

  it("offers nothing for a refusal with no reviewer answer, or for a non-approve action", () => {
    // Positive landmark first: the same response DOES produce choices for approve.
    const dup = { ok: false, code: "duplicate", suggest: SUGGEST };
    expect(refusalChoices({ action: "approve" }, dup)).toHaveLength(2);
    expect(refusalChoices({ action: "link", event_id: "x" }, dup)).toEqual([]);
    expect(
      refusalChoices(
        { action: "approve" },
        { ok: false, code: "already_reviewed", suggest: SUGGEST }
      )
    ).toEqual([]);
    expect(
      refusalChoices({ action: "reject", note: "r" }, { ok: false, code: "bad_request" })
    ).toEqual([]);
  });
});

describe("parseReviewState", () => {
  it("defaults to the queue and rejects unknown states", () => {
    expect(parseReviewState(undefined)).toBe("awaiting_review");
    expect(parseReviewState("bogus")).toBe("awaiting_review");
    expect(parseReviewState("rejected")).toBe("rejected");
    expect(parseReviewState("all")).toBe("all");
  });
});

describe("FeedItemReviewActions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    refresh.mockReset();
  });

  function stubFetch(...responses: { status: number; body: unknown }[]) {
    const fetchMock = vi.fn();
    for (const r of responses)
      fetchMock.mockResolvedValueOnce({
        ok: r.status < 400,
        status: r.status,
        json: async () => r.body,
      });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const sentBody = (f: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse((f.mock.calls[i][1] as RequestInit).body as string);

  it("approve posts to the item's review route and refreshes on success", async () => {
    const f = stubFetch({
      status: 200,
      body: {
        ok: true,
        event: {
          id: "e",
          slug: "s",
          name: "Bath Antique Sale",
          status: "APPROVED",
          series_id: null,
        },
      },
    });
    const ui = render(<FeedItemReviewActions feedItemId="item/1" closestEvent={null} />);
    fireEvent.click(ui.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe("/api/admin/feed-items/item%2F1/review");
    expect(sentBody(f, 0)).toEqual({ action: "approve" });
    expect(ui.getByText('Created "Bath Antique Sale" (APPROVED).')).toBeTruthy();
  });

  it("a venue refusal shows the candidates, and one click retries with venue_id", async () => {
    const f = stubFetch(
      {
        status: 422,
        body: {
          ok: false,
          code: "venue_unmatched",
          message: "The feed's venue matches no venue we have.",
          venue_candidates: [{ id: "v-1", name: "Railway Museum", city: "Boothbay", state: "ME" }],
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          event: {
            id: "e",
            slug: "s",
            name: "North Pole Express",
            status: "APPROVED",
            series_id: "s9",
          },
        },
      }
    );
    const ui = render(<FeedItemReviewActions feedItemId="i" closestEvent={null} />);
    fireEvent.click(ui.getByRole("button", { name: "Approve" }));
    const pick = await ui.findByRole("button", { name: "Use venue: Railway Museum, Boothbay ME" });
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(pick);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sentBody(f, 1)).toEqual({ action: "approve", venue_id: "v-1" });
  });

  it("reject needs a reason before it can be sent", async () => {
    const f = stubFetch({ status: 200, body: { ok: true } });
    const ui = render(<FeedItemReviewActions feedItemId="i" closestEvent={null} />);
    fireEvent.click(ui.getByRole("button", { name: "Reject…" }));
    const confirm = ui.getByRole("button", { name: "Confirm reject" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(ui.getByLabelText("Review note"), { target: { value: "private event" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sentBody(f, 0)).toEqual({ action: "reject", note: "private event" });
  });

  it("link is prefilled with the closest listing", async () => {
    const f = stubFetch({ status: 200, body: { ok: true } });
    const ui = render(
      <FeedItemReviewActions feedItemId="i" closestEvent={{ id: "ev-7", name: "Saco Parade" }} />
    );
    fireEvent.click(ui.getByRole("button", { name: "Link…" }));
    expect((ui.getByLabelText("Event id") as HTMLInputElement).value).toBe("ev-7");
    fireEvent.click(ui.getByRole("button", { name: "Confirm link" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sentBody(f, 0)).toEqual({ action: "link", event_id: "ev-7" });
  });
});
