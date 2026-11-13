/**
 * OPE-1624 (John, 2026-11-12) — link the promoter post from /list-your-event
 * (and its state pages, which share the landing) and from /for-promoters.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/list-your-event/list-event-form", () => ({ ListEventForm: () => null }));

import { ListYourEventLanding } from "@/components/list-your-event/list-your-event-landing";
import { PROMOTER_GUIDE_LINK_TEXT, PROMOTER_GUIDE_POST_PATH } from "../landing-content";

const ROOT = join(__dirname, "../../../..");

describe("OPE-1624 promoter guide link", () => {
  it("points at the published post's slug", () => {
    // Verified PUBLISHED in prod D1 2026-11-13 (blog_posts 9be55a5b).
    expect(PROMOTER_GUIDE_POST_PATH).toBe(
      "/blog/list-your-event-free-how-promoters-get-their-fairs-and-shows-on-meet-me-at-the-fair"
    );
  });

  it.each([undefined, "Maine"])("renders on the list-your-event landing (state %s)", (state) => {
    const html = renderToStaticMarkup(
      <ListYourEventLanding stateName={state} stateCode={state ? "ME" : undefined} />
    );
    expect(html).toContain(`href="${PROMOTER_GUIDE_POST_PATH}"`);
    expect(html).toContain(PROMOTER_GUIDE_LINK_TEXT);
  });

  it("/for-promoters links the post and the free listing form", () => {
    const src = readFileSync(join(ROOT, "src/app/for-promoters/page.tsx"), "utf8");
    expect(src).toContain("href={PROMOTER_GUIDE_POST_PATH}");
    expect(src).toContain('href="/list-your-event"');
  });
});
