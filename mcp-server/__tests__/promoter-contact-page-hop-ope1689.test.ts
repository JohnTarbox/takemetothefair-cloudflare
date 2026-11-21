/**
 * OPE-1689 — before a promoter run can count as empty, it follows ONE same-site
 * Contact link. Driven through the real dispatcher with a fetch stub that
 * counts renders per host, on the three shapes the ticket measured:
 * Coggeshall (one clean mailto on /contact-us), Caledonia (a multi-person page)
 * and RI Anime Con (form only — exhaustion must still work).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { promoterEnrichmentCandidates, promoters } from "../src/schema.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../src/enrichment/promoter-dispatch.js";
import { contactPageSignals, findContactLink } from "../src/enrichment/contact-page.js";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test",
  MAIN_APP_URL: "https://meetmeatthefair.com",
  INTERNAL_API_KEY: "k",
} as unknown as PromoterEnrichmentEnv;

const HOST = "farm.example.com";
const HOME = `<html><body><nav>
  <a href="/events">Events</a>
  <a href="/about-us/">About</a>
  <a href="/about-us/contact-us/">Contact Us</a>
</nav><p>Welcome to the farm.</p></body></html>`;

const people = Array.from(
  { length: 26 },
  (_, i) =>
    `<li>Person ${i} <a href="mailto:person${i}@caledonia-fixture.org">email</a> 802-555-${String(1000 + i)}</li>`
).join("");

let db: TestDb;
let indexNow: ReturnType<typeof mockIndexNowFetch>;
let restoreFetch: (() => void) | null = null;
let renders: string[] = [];

function serve(pages: Record<string, string>) {
  restoreFetch?.();
  renders = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === HOST) {
      renders.push(url.pathname);
      const html = pages[url.pathname.replace(/\/+$/, "") || "/"];
      return html
        ? new Response(html, { status: 200, headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    }
    return orig(input, init);
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = orig);
}

beforeEach(async () => {
  ({ db } = createTestDb());
  indexNow = mockIndexNowFetch();
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Coggeshall Farm Museum",
    slug: "coggeshall-farm-museum",
    website: `https://${HOST}/`,
    enrichmentStatus: "NEEDS_ENRICHMENT",
  } as never);
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  indexNow.restore();
});

const run = (dryRun: boolean) =>
  processPromoterEnrichmentJob(db, ENV, {
    promoterId: "p1",
    jobRunId: `j-${Math.random()}`,
    dryRun,
  });
const rows = async (field: string) =>
  db
    .select()
    .from(promoterEnrichmentCandidates)
    .where(eq(promoterEnrichmentCandidates.proposedField, field));
const promoter = async () => (await db.select().from(promoters).where(eq(promoters.id, "p1")))[0];

describe("OPE-1689 — one Contact-page hop", () => {
  it("ACCEPTANCE (Coggeshall): finds the contact-page mailto, records the page as source, two renders", async () => {
    serve({
      "/": HOME,
      "/about-us/contact-us": `<p>Write to <a href="mailto:info@coggeshall-fixture.org">us</a>.</p>`,
    });
    const res = await run(true);
    const [c] = await rows("contact_email");
    expect(c.proposedValue).toBe("info@coggeshall-fixture.org");
    expect(c.extractionMethod).toBe("mailto");
    expect(c.sourceUrl).toBe(`https://${HOST}/about-us/contact-us/`);
    expect(res.contactPageUrl).toBe(`https://${HOST}/about-us/contact-us/`);
    expect(renders).toEqual(["/", "/about-us/contact-us/"]); // "contact" beat "about"
  });

  it("a single clean contact-page mailto auto-applies on a live run, like a homepage one", async () => {
    serve({
      "/": HOME,
      "/about-us/contact-us": `<a href="mailto:info@coggeshall-fixture.org">us</a>`,
    });
    await run(false);
    expect((await promoter()).contactEmail).toBe("info@coggeshall-fixture.org");
  });

  it("ACCEPTANCE (Caledonia): a 26-person page auto-applies nothing; only a ROLE mailbox stages, flagged", async () => {
    serve({
      "/": HOME,
      "/about-us/contact-us": `<ul>${people}<li>Fair office <a href="mailto:office@caledonia-fixture.org">office</a></li></ul>`,
    });
    const res = await run(false);
    const p = await promoter();
    expect(p.contactEmail).toBeNull();
    expect(p.contactPhone).toBeNull();
    const emails = await rows("contact_email");
    expect(emails).toHaveLength(1);
    expect(emails[0].proposedValue).toBe("office@caledonia-fixture.org");
    expect(emails[0].decision).toBe("pending");
    expect(JSON.parse(emails[0].flags)).toContain("contact_page_multiple");
    expect(await rows("contact_phone")).toHaveLength(0); // 26 unlabelled numbers: none chosen
    expect(res.appliedFields ?? []).toEqual([]);
  });

  it("a multi-person page with NO role mailbox stages no email at all", async () => {
    serve({ "/": HOME, "/about-us/contact-us": `<ul>${people}</ul>` });
    await run(true);
    expect(await rows("contact_email")).toHaveLength(0);
  });

  it("a multi-number page stages the ONE number labelled main/office/general, never auto-applied", async () => {
    serve({
      "/": HOME,
      "/about-us/contact-us": `<ul>${people}</ul><p>Main office line: 802-427-4404</p>`,
    });
    await run(false);
    expect((await promoter()).contactPhone).toBeNull();
    const [ph] = await rows("contact_phone");
    expect(ph.proposedValue).toBe("(802) 427-4404");
    expect(JSON.parse(ph.flags)).toContain("contact_page_multiple");
  });

  it("ACCEPTANCE (RI Anime Con): a form-only Contact page still counts the run as empty", async () => {
    serve({
      "/": HOME,
      "/about-us/contact-us": `<form action="/send"><input name="email"><textarea></textarea></form>`,
    });
    const res = await run(false);
    expect(renders).toHaveLength(2); // the hop really happened
    expect(res.newCandidateCount).toBe(0);
    expect(res.emptyAttempts).toBe(1);
  });

  it("no hop when email AND phone are already on file — one render", async () => {
    await db
      .update(promoters)
      .set({ contactEmail: "info@farm-fixture.org", contactPhone: "(401) 555-0100" })
      .where(eq(promoters.id, "p1"));
    serve({ "/": HOME, "/about-us/contact-us": `<a href="mailto:x@farm-fixture.org">x</a>` });
    await run(true);
    expect(renders).toEqual(["/"]);
  });

  it("no hop when the homepage itself yielded the missing contact", async () => {
    serve({
      "/": HOME.replace(
        "Welcome",
        `<a href="mailto:hi@farm-fixture.org">hi</a> <a href="tel:4015550100">call</a> Welcome`
      ),
      "/about-us/contact-us": `<a href="mailto:x@farm-fixture.org">x</a>`,
    });
    await run(true);
    expect(renders).toEqual(["/"]);
  });
});

describe("findContactLink", () => {
  const base = "https://farm.example.com/";
  it("prefers contact over get-in-touch over about, and ignores other origins / mailto / self", () => {
    expect(
      findContactLink(
        `<a href="https://other.org/contact">x</a><a href="mailto:a@b.co">Contact</a>
         <a href="/">Contact home</a><a href="/about">About</a><a href="/reach">Get in touch</a>`,
        base
      )
    ).toBe("https://farm.example.com/reach");
    expect(findContactLink(`<a href="/about">About</a>`, base)).toBe(
      "https://farm.example.com/about"
    );
    expect(findContactLink(`<a href="/events">Events</a>`, base)).toBeNull();
  });
});

describe("contactPageSignals (unit)", () => {
  it("one distinct address keeps its ordinary method; several without a role yield none", () => {
    expect(
      contactPageSignals(
        `<a href="mailto:a@farm-fixture.org">a</a>`,
        "https://farm.example.com/c",
        {
          email: true,
          phone: false,
        }
      ).contactEmail
    ).toMatchObject({ value: "a@farm-fixture.org", method: "mailto", multiple: false });
    expect(
      contactPageSignals(people, "https://farm.example.com/c", { email: true, phone: true })
    ).toEqual({});
  });
});
