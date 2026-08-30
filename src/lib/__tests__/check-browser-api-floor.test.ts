/**
 * OPE-640 — the browser-support-floor guard.
 *
 * The defect it exists to catch served a BLANK PAGE (the React error boundary)
 * to every visitor below Safari 15.4 / Chrome 92 on `/events/*`, nine times
 * across eight events, because `crypto.randomUUID()` was called unguarded
 * during render in a client-reachable module.
 *
 * Both halves matter, and the second decides whether the guard survives
 * contact with the repo: it must catch the unguarded shape, and it must stay
 * quiet on the ~30 SERVER call sites where the Workers runtime always provides
 * the API. A guard that flagged those would be blanket-disabled within a week
 * and would then guard nothing — the lesson recorded in
 * check-d1-inarray-params.ts and repeated in check-d1-like-user-input.ts.
 */
import { describe, it, expect } from "vitest";
import {
  checkSource,
  isClientEntry,
  importSpecifiers,
} from "../../../scripts/check-browser-api-floor";

describe("catches the shape that actually blanked the page", () => {
  it("flags an unguarded crypto.randomUUID()", () => {
    // src/lib/utils.ts:291 verbatim, as it shipped.
    const src = "      `UID:${day.date}-${crypto.randomUUID()}@${SITE_HOSTNAME}`,";
    const v = checkSource("src/lib/utils.ts", src, "src/components/events/AddToCalendar.tsx");
    expect(v).toHaveLength(1);
    expect(v[0].api).toBe("crypto.randomUUID()");
    expect(v[0].since).toMatch(/Safari 15\.4/);
  });

  it("flags the other above-floor APIs in the same family", () => {
    const cases = [
      "const c = structuredClone(x);",
      "if (Object.hasOwn(o, k)) {}",
      "arr.findLast(f)",
    ];
    for (const src of cases) {
      expect(checkSource("src/lib/x.ts", src, "entry.tsx").length).toBeGreaterThan(0);
    }
  });
});

describe("stays quiet where it must", () => {
  it("does not flag a guarded call", () => {
    const guarded = [
      "const id = crypto.randomUUID?.() ?? fallback();",
      'const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : fb();',
    ];
    for (const src of guarded) {
      expect(checkSource("src/lib/x.ts", src, "entry.tsx")).toHaveLength(0);
    }
  });

  it("does not flag an API that is BELOW the declared floor", () => {
    // String.replaceAll is Safari 13.1 / Chrome 85 — under the floor, so it is
    // deliberately absent from ABOVE_FLOOR. An entry that is actually safe
    // teaches people to ignore the guard.
    expect(checkSource("src/lib/x.ts", 's.replaceAll("a","b")', "entry.tsx")).toHaveLength(0);
  });

  it("does not flag a commented-out call", () => {
    expect(checkSource("src/lib/x.ts", "// const id = crypto.randomUUID();", "e.tsx")).toHaveLength(
      0
    );
  });
});

describe("reachability is what keeps the guard precise", () => {
  it('recognises a "use client" entry, including after a licence comment', () => {
    expect(isClientEntry('"use client";\nimport x from "y";')).toBe(true);
    expect(isClientEntry('/* header */\n"use client";')).toBe(true);
    expect(isClientEntry("// note\n'use client';")).toBe(true);
  });

  it('does NOT treat a server module mentioning "use client" as an entry', () => {
    // This is the whole reason ~30 server randomUUID call sites stay unflagged.
    const serverModule = 'import { db } from "@/lib/db";\nconst doc = \'"use client"\';';
    expect(isClientEntry(serverModule)).toBe(false);
  });

  it("collects static and dynamic import specifiers", () => {
    const src = `
      import { a } from "@/lib/utils";
      import b from "./local";
      const c = await import("@/lib/lazy");
    `;
    expect(importSpecifiers(src)).toEqual(["@/lib/utils", "./local", "@/lib/lazy"]);
  });
});
