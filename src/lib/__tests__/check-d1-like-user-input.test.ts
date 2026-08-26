/**
 * OPE-565 — the LIKE-from-user-input guard.
 *
 * This family produced 315 production errors across five call sites in 27 days
 * and is the THIRD distinct D1 limit the repo has shipped an outage against.
 * OPE-79 fixed one call site of the sibling bind-param cap, shipped no guard,
 * and it recurred — so the guard, not the conversions, is the deliverable here,
 * and these lock its behaviour.
 *
 * Both halves matter, and the second is the one that decides whether the guard
 * survives: it must catch the known-bad shape, and it must stay quiet on the
 * ~50 legitimate LIKE sites that interpolate category constants and HOST
 * prefixes. A guard that flags those gets bulk-allowlisted within a week and
 * then guards nothing — the explicit lesson recorded in
 * check-d1-inarray-params.ts.
 *
 * Exercises the pure `checkFile` against synthetic source — no filesystem, no
 * process.exit.
 */
import { describe, it, expect } from "vitest";
import { checkFile } from "../../../scripts/check-d1-like-user-input";

describe("catches the shape that actually broke production", () => {
  it("flags a LIKE pattern built from a searchParams value", () => {
    // The /events listing, verbatim in shape — 71 logged failures.
    const src = `
      const query = searchParams.query.toLowerCase().trim();
      conditions.push(like(events.name, \`%\${query}%\`));
    `;
    const v = checkFile("src/app/events/page.tsx", src);
    expect(v).toHaveLength(1);
    expect(v[0].why).toMatch(/request-derived/);
  });

  it('flags the `"%" + q + "%"` concatenation form too', () => {
    // /venues used this spelling rather than a template literal. A guard that
    // only understood template literals would have walked straight past it.
    const src = `
      const q = searchParams.get("q");
      conditions.push(sql\`\${venues.name} LIKE \${"%" + q + "%"}\`);
    `;
    expect(checkFile("src/app/venues/page.tsx", src).length).toBeGreaterThan(0);
  });

  it("flags a value destructured out of a request body", () => {
    const src = `
      const { venueName } = await request.json();
      const rows = await db.select().from(venues).where(like(venues.name, \`%\${venueName}%\`));
    `;
    expect(checkFile("src/app/api/x/route.ts", src).length).toBeGreaterThan(0);
  });

  it("flags sanitizeLikeInput anywhere — it is a false guard, not a fix", () => {
    // It REPLACES `%` with `\\%`, an escape only honoured alongside an ESCAPE
    // clause that Drizzle cannot emit. So the wildcard survived AND the pattern
    // got longer: it made both problems worse while reading as protection.
    const src = `const safe = sanitizeLikeInput(input);`;
    const v = checkFile("src/app/api/x/route.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0].why).toMatch(/escapes rather than strips/);
  });
});

describe("stays quiet on the legitimate sites — the half that keeps it alive", () => {
  it("ignores a literal pattern", () => {
    expect(checkFile("x.ts", `like(events.slug, "%-merged-%")`)).toEqual([]);
  });

  it("ignores a loop over a module constant — the category-list shape", () => {
    // ~10 real sites look like this. Flagging them would make the guard noise.
    const src = `
      const producerCond = or(
        ...PRODUCER_CLASS_CATEGORIES.map((c) => like(events.categories, \`%"\${c}"%\`))
      );
    `;
    expect(checkFile("src/app/api/x/route.ts", src)).toEqual([]);
  });

  it("ignores a HOST-prefixed anchored pattern", () => {
    const src =
      "await db.select().from(t).where(like(gscInspectionState.url, `${HOST}/events/%`));";
    expect(checkFile("src/lib/gsc-sweep.ts", src)).toEqual([]);
  });

  it("ignores a pattern built from a DB row rather than a request", () => {
    const src = `
      const row = await db.select().from(events).limit(1);
      conditions.push(like(blogPosts.tags, \`%\${row.name}%\`));
    `;
    expect(checkFile("src/app/x/page.tsx", src)).toEqual([]);
  });

  it("does not flag sanitizeLikeInput inside its own former home", () => {
    // The removal note in src/lib/utils.ts names the function so the next
    // reader understands why it is gone. That mention must not fail the build.
    const src = `export function sanitizeLikeInput(input: string) { return input; }`;
    expect(checkFile("src/lib/utils.ts", src)).toEqual([]);
  });

  it("does not flag its own source or a comment mentioning the pattern", () => {
    expect(checkFile("scripts/check-d1-like-user-input.ts", `sanitizeLikeInput(x)`)).toEqual([]);
    expect(checkFile("x.ts", "// like(events.name, `%${query}%`) — the old shape")).toEqual([]);
  });
});

describe("the fix it points at", () => {
  it("accepts containsCI, which is what the guard tells you to use", () => {
    const src = `
      const query = searchParams.query.toLowerCase().trim();
      conditions.push(or(containsCI(events.name, query), containsCI(events.description, query))!);
    `;
    expect(checkFile("src/app/events/page.tsx", src)).toEqual([]);
  });
});
