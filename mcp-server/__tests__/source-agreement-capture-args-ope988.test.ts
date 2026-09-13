/**
 * OPE-988 — pins the ARGUMENTS the capture passes, because two of them are
 * invisible in a stored row at today's scores:
 *
 * `forceOutreachCandidate: false` only changes a row whose initial score clears
 * the 0.6 outreach threshold. An `existence` row with no view count never does,
 * so the real-DB test stays green with the override deleted (measured: removed
 * it AND raised confidence to 1 — still 3/3 green). A later scoring change
 * would silently start emailing organizers about OUR attribution errors.
 */
import { describe, expect, it, vi } from "vitest";

const captureDiscrepancy = vi.fn(async (_db: unknown, _args: unknown) => "id-1");
vi.mock("../src/goodwill/capture.js", () => ({
  captureDiscrepancy: (db: unknown, args: unknown) => captureDiscrepancy(db, args),
}));

const { captureSourceAgreementDisagreements } =
  await import("../src/goodwill/source-agreement-capture.js");

describe("OPE-988 capture arguments", () => {
  it("existence / source_agreement, outreach suppressed", async () => {
    await captureSourceAgreementDisagreements({} as never, [
      {
        eventId: "e",
        slug: "s",
        sourceUrl: "https://www.johnnyappleseedfest.com/",
        city: "Leominster",
        state: "MA",
        venueName: null,
        otherStates: ["IN"],
        signals: [],
        detail: "d",
      },
    ]);
    expect(captureDiscrepancy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        eventId: "e",
        fieldClass: "existence",
        detectedBy: "source_agreement",
        forceOutreachCandidate: false,
      })
    );
  });
});
