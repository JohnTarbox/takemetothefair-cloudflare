import { describe, expect, it, vi } from "vitest";
import { isRealSlugRename, recordSlugRename } from "../src/slug-history.js";

describe("isRealSlugRename (OPE-495)", () => {
  it("is a rename only when both slugs are present and differ", () => {
    expect(isRealSlugRename("old-slug", "new-slug")).toBe(true);
  });

  it("is NOT a rename when the slug is re-derived unchanged", () => {
    // The common case by far: update_promoter regenerates the slug whenever
    // `name` is passed, including when the name did not actually change. Without
    // this guard every such edit would write a self-referential history row —
    // old_slug === new_slug — which the middleware walker would follow to
    // itself.
    expect(isRealSlugRename("same-slug", "same-slug")).toBe(false);
  });

  it.each([
    [null, "new-slug"],
    [undefined, "new-slug"],
    ["", "new-slug"],
    ["old-slug", null],
    ["old-slug", undefined],
    ["old-slug", ""],
  ])("is NOT a rename when a side is missing (%s → %s)", (from, to) => {
    expect(isRealSlugRename(from as string | null, to as string | null)).toBe(false);
  });
});

describe("recordSlugRename (OPE-495)", () => {
  it("writes the row with both slugs when the slug changed", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const wrote = await recordSlugRename({
      label: "update_promoter",
      entityId: "p1",
      previousSlug: "cape-cod-creative-arts-festival",
      nextSlug: "creative-arts-center",
      write,
    });
    expect(wrote).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("cape-cod-creative-arts-festival", "creative-arts-center");
  });

  it("does not call the writer at all for a no-op edit", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const wrote = await recordSlugRename({
      label: "update_venue",
      entityId: "v1",
      previousSlug: "same-slug",
      nextSlug: "same-slug",
      write,
    });
    expect(wrote).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not call the writer when the tool passed no new slug", async () => {
    // update_venue only sets `updates.slug` when `name` was supplied, so most
    // calls arrive with nextSlug undefined.
    const write = vi.fn().mockResolvedValue(undefined);
    expect(
      await recordSlugRename({
        label: "update_venue",
        entityId: "v1",
        previousSlug: "a-venue",
        nextSlug: undefined,
        write,
      })
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("SWALLOWS a write failure — the rename itself already committed", async () => {
    // The property that matters: this runs after the entity UPDATE has landed.
    // Throwing here would fail a tool call whose primary write succeeded,
    // turning a missing redirect into a confusing partial error.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.fn().mockRejectedValue(new Error("D1_ERROR: no such table"));

    await expect(
      recordSlugRename({
        label: "update_promoter",
        entityId: "p1",
        previousSlug: "old-slug",
        nextSlug: "new-slug",
        write,
      })
    ).resolves.toBe(false);

    // ...but it must be LOUD. A silently swallowed failure here reproduces the
    // exact invisibility this ticket is about.
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("update_promoter");
    expect(String(err.mock.calls[0][0])).toContain("old-slug → new-slug");
    err.mockRestore();
  });
});
