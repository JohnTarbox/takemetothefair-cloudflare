/**
 * OPE-403 — the reconciliation that would have caught the 2026-08-15 loss.
 *
 * The `photo-intake` heartbeat probe was GREEN throughout that failure: it reads
 * `max(inbound_emails.received_at)` and the emails kept arriving. What stopped
 * was the write at the far end. This check compares what we ACKNOWLEDGED against
 * what we STORED, which is the question a liveness probe structurally cannot ask.
 */
import { describe, expect, it } from "vitest";
import { assessUnstoredPhotoIntakes } from "@/lib/photo-intake-reconcile";

const NOW = new Date("2026-08-16T12:00:00Z");

describe("assessUnstoredPhotoIntakes", () => {
  it("stays silent when every acknowledged photo was stored", () => {
    expect(assessUnstoredPhotoIntakes({ count: 0, oldestAt: null }, NOW)).toBeNull();
  });

  it("fires on the 2026-08-15 shape — 5 acked, 0 stored", () => {
    const red = assessUnstoredPhotoIntakes(
      { count: 5, oldestAt: new Date("2026-08-15T12:02:27Z") },
      NOW
    );

    expect(red).not.toBeNull();
    expect(red!.title).toContain("5 emails");
    expect(red!.title).toContain("stored 0 photos");
  });

  it("is P0 — we told a person we had their photos", () => {
    // Not P1. A P1 sits 72h before it counts as stale; the failure here is an
    // unkept promise to a real submitter, and it should reach the operator the
    // same day.
    const red = assessUnstoredPhotoIntakes({ count: 1, oldestAt: new Date(NOW) }, NOW);
    expect(red!.priority).toBe("P0");
  });

  it("ages from the OLDEST unstored row, not from now", () => {
    // hoursInRed drives the digest's escalation. Anchoring it on the newest row
    // would let a persistent backlog look permanently fresh.
    const red = assessUnstoredPhotoIntakes(
      { count: 2, oldestAt: new Date("2026-08-15T12:00:00Z") },
      NOW
    );
    expect(red!.hoursInRed).toBeCloseTo(24, 5);
    expect(red!.firstDetectedAt).toBe("2026-08-15T12:00:00.000Z");
  });

  it("keeps a stable refKey so the digest can dedup it across days", () => {
    // OPE-308 fingerprints the sorted refKey set and pushes on CHANGE. A refKey
    // that varied with the count would re-page every single day.
    const a = assessUnstoredPhotoIntakes({ count: 1, oldestAt: new Date(NOW) }, NOW);
    const b = assessUnstoredPhotoIntakes({ count: 9, oldestAt: new Date(NOW) }, NOW);
    expect(a!.refKey).toBe(b!.refKey);
    expect(a!.refKey).toBe("photo-intake:acked-unstored");
  });

  it("singular copy for a single email", () => {
    const red = assessUnstoredPhotoIntakes({ count: 1, oldestAt: new Date(NOW) }, NOW);
    expect(red!.title).toContain("1 email ");
    expect(red!.title).not.toContain("1 emails");
  });

  it("points the operator at the flagged review queue", () => {
    const red = assessUnstoredPhotoIntakes({ count: 3, oldestAt: new Date(NOW) }, NOW);
    expect(red!.href).toContain("/admin/inbound-emails");
  });

  it("a count with no timestamp cannot age, so it does not fire", () => {
    // Defensive: min(received_at) returning null alongside a non-zero count
    // would mean the aggregate disagrees with itself. Emitting a red with a
    // fabricated clock would be worse than staying quiet about it.
    expect(assessUnstoredPhotoIntakes({ count: 4, oldestAt: null }, NOW)).toBeNull();
  });
});
