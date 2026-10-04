/**
 * OPE-1209 — the vendor newsletter's own surfaces offered the ATTENDEE signup.
 *
 * Mechanism (read from main, correcting the ticket's inferred one): the vendor
 * archive `/newsletter/vendor` rendered no signup of its own — the attendee form
 * a vendor saw there was the SITE FOOTER's, present on every page. `/vendors`
 * had only the footer too, and a vendor issue's view-in-browser page rendered
 * the attendee block.
 *
 * The list is decided server-side from `source` alone (`listForSource`: exactly
 * "vendor-form" → vendor). So these tests follow the posted `source` through the
 * REAL `listForSource` in both directions, at every layer that chooses it —
 * the composer, not just the rendered label (the OPE-359/360 lesson).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listForSource } from "@/lib/email/newsletter-list-membership";
import { newsletterDigestTemplate } from "@/lib/email/templates";
import { NEWSLETTER_NAME, VENDOR_NEWSLETTER_NAME } from "@/lib/newsletter-masthead";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/lib/analytics", () => ({ trackFormSubmit: () => {} }));
const enqueued: Array<{ html: string; text: string }> = [];
vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: async (m: { html: string; text: string }) => {
    enqueued.push(m);
  },
}));

const { NewsletterSignup } = await import("@/components/layout/newsletter-signup");
const { NewsletterSignupBlock } = await import("@/components/newsletter/newsletter-signup-block");
const { FooterNewsletterSlot } = await import("@/components/layout/footer-newsletter-slot");
const { enqueueNewsletterDigest } = await import("@/lib/email/newsletter-broadcast");

let posted: Array<{ email: string; source: string }> = [];
beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function submit(container: HTMLElement) {
  const input = container.querySelector("input[type=email]") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "a@example.com" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(posted).toHaveLength(1));
  return posted[0];
}

describe("the form: the list a signup lands on, followed through listForSource", () => {
  it("a vendor form posts vendor-form → the VENDOR list, and says New This Week", async () => {
    const { container, getByText } = render(<NewsletterSignup audience="vendor" />);
    getByText(VENDOR_NEWSLETTER_NAME);
    const body = await submit(container);
    expect(body.source).toBe("vendor-form");
    expect(listForSource(body.source)).toBe("vendor");
  });

  it("the vendor audience fixes the source — a surface label cannot divert it to weekend", async () => {
    const { container } = render(<NewsletterSignup audience="vendor" source="vendors-directory" />);
    expect(listForSource((await submit(container)).source)).toBe("vendor");
  });

  it("NO REGRESSION: the default form still lands on the WEEKEND list", async () => {
    const { container, getByText } = render(<NewsletterSignup source="event-detail" />);
    getByText(NEWSLETTER_NAME);
    const body = await submit(container);
    expect(body.source).toBe("event-detail");
    expect(listForSource(body.source)).toBe("weekend");
  });

  it("the block: vendor → vendor list; default (event/blog surfaces) → weekend", async () => {
    const v = render(<NewsletterSignupBlock source="vendor-archive" audience="vendor" />);
    expect(listForSource((await submit(v.container)).source)).toBe("vendor");
    cleanup();
    posted = [];
    const w = render(<NewsletterSignupBlock source="blog-post" />);
    expect(listForSource((await submit(w.container)).source)).toBe("weekend");
  });

  it("two forms on one page get distinct input ids (label pairing stays correct)", () => {
    const { container } = render(
      <>
        <NewsletterSignup audience="vendor" />
        <NewsletterSignup />
      </>
    );
    const ids = [...container.querySelectorAll("input[type=email]")].map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the footer: no second, different-list form on the vendor archive", () => {
  it("/newsletter/vendor: the footer offers the attendee newsletter as a LINK, not a form", () => {
    pathname = "/newsletter/vendor";
    const { container, getByRole } = render(<FooterNewsletterSlot />);
    expect(container.querySelector("form")).toBeNull();
    expect(getByRole("link", { name: NEWSLETTER_NAME }).getAttribute("href")).toBe("/newsletter");
  });

  it("everywhere else the footer is still the attendee form (landmark for the case above)", async () => {
    pathname = "/vendors";
    const { container } = render(<FooterNewsletterSlot />);
    expect(listForSource((await submit(container)).source)).toBe("weekend");
  });
});

describe("the surfaces carry the vendor block", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  it("/newsletter/vendor and /vendors render the block with audience=vendor", () => {
    expect(read("src/app/newsletter/vendor/page.tsx")).toMatch(
      /<NewsletterSignupBlock[^>]*audience="vendor"/
    );
    expect(read("src/app/vendors/(listing)/page.tsx")).toMatch(
      /<NewsletterSignupBlock[^>]*audience="vendor"/
    );
  });
});

describe("the vendor digest email: a forward CTA, and only there", () => {
  const base = {
    subject: "New This Week — Sep 28",
    contentHtml: "<p>shows</p>",
    unsubscribeUrl: "https://meetmeatthefair.com/api/newsletter/unsubscribe?token=abc",
    viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/new-this-week-2026-09-28",
  };
  it("vendor: the footer links /newsletter/vendor in HTML and text", () => {
    const { html, text } = newsletterDigestTemplate({ ...base, audience: "vendor" });
    expect(html).toContain('href="https://meetmeatthefair.com/newsletter/vendor"');
    expect(html).toContain("Did a fellow exhibitor forward this?");
    expect(text).toContain("https://meetmeatthefair.com/newsletter/vendor");
  });
  it("weekend (and an unset audience): no vendor CTA", () => {
    for (const audience of ["weekend", undefined] as const) {
      const { html, text } = newsletterDigestTemplate({ ...base, audience });
      expect(html).not.toContain("/newsletter/vendor");
      expect(html).not.toContain("fellow exhibitor");
      expect(text).not.toContain("/newsletter/vendor");
    }
  });
});

describe("the shared send rail threads the audience to the template", () => {
  // The template test above is not enough on its own: every real send goes
  // through enqueueNewsletterDigest, and a rail that dropped `audience` would
  // silently ship vendor issues without the CTA while that test stayed green.
  const send = async (audience: "vendor" | "weekend") => {
    enqueued.length = 0;
    await enqueueNewsletterDigest({
      recipients: ["r@example.com"],
      audience,
      subject: "s",
      contentHtml: "<p>x</p>",
      viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/x",
      siteUrl: "https://meetmeatthefair.com",
      secret: "test-secret-test-secret-test-secret",
    });
    expect(enqueued).toHaveLength(1);
    return enqueued[0];
  };
  it("a vendor broadcast carries the CTA", async () => {
    expect((await send("vendor")).html).toContain("/newsletter/vendor");
  });
  it("a weekend broadcast does not", async () => {
    expect((await send("weekend")).html).not.toContain("/newsletter/vendor");
  });
});

/**
 * OPE-1209 (rework 2026-10-04) — the in-page block is LEGIBLE and says its name
 * once. Seen in a real browser: the block wrapped the footer-styled form, so on
 * every event page, blog post, /newsletter and /vendors the label, blurb and
 * typed email rendered near-white (`text-footer-foreground`) on a light card,
 * and the label + blurb duplicated the card's own heading.
 */
describe("legibility on light surfaces", () => {
  const footerClass = (el: Element) => /\bfooter-foreground\b/.test(el.className);

  it.each([
    ["vendor", VENDOR_NEWSLETTER_NAME],
    ["weekend", NEWSLETTER_NAME],
  ] as const)("the %s block uses NO footer (light-on-dark) tokens anywhere", (aud, name) => {
    const { container } = render(<NewsletterSignupBlock source="x" audience={aud} />);
    expect([...container.querySelectorAll("*")].filter(footerClass)).toEqual([]);
    // …and states its name exactly once visibly: the heading. The form's label
    // is kept for screen readers only.
    const label = container.querySelector("form label")!;
    expect(label.textContent).toBe(name);
    expect(label.className).toContain("sr-only");
    expect(container.querySelector("form p")).toBeNull(); // no second blurb
  });

  it("the sr-only label still pairs with the input, and the input keeps its accessible name", () => {
    const { container, getByLabelText } = render(
      <NewsletterSignupBlock source="x" audience="vendor" />
    );
    const label = container.querySelector("form label") as HTMLLabelElement;
    const input = container.querySelector("input[type=email]")!;
    expect(label.htmlFor).toBe(input.id);
    // aria-label wins the accessible-name computation (unchanged by this rework).
    expect(getByLabelText("Email address")).toBe(input);
  });

  it("NO REGRESSION: the footer form (no tone) keeps its light-on-dark tokens and visible intro", () => {
    const { container } = render(<NewsletterSignup />);
    const label = container.querySelector("form label")!;
    expect(label.className).not.toContain("sr-only");
    expect(footerClass(label)).toBe(true);
    expect(footerClass(container.querySelector("input[type=email]")!)).toBe(true);
  });

  it("/newsletter renders its form in surface tone", () => {
    const src = readFileSync(join(process.cwd(), "src/app/newsletter/page.tsx"), "utf8");
    expect(src).toContain('<NewsletterSignup source="newsletter-page" tone="surface" />');
  });
});
