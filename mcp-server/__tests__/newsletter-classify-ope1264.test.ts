/**
 * OPE-1264 (classify + attribute + record, shadow mode) — a promoter newsletter
 * is recognised, attributed, recorded, and never draws a single-event ack.
 *
 * Fixtures are modelled on the measured specimens (prod D1, 2026-10-02): each
 * carries its ESP's real marker set. They are not replays — replaying a real
 * inbound would send another ack.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { attributeNewsletter, detectNewsletter } from "../src/inbound/newsletter.js";
import { classifyAndRecordNewsletter } from "../src/inbound/newsletter-record.js";
import { inboundEmails, inboundNewsletters, promoters, workflowRunSteps } from "../src/schema.js";

/** 24c583d5 — Maine Lobster Festival, Mailchimp, inline forward. */
const MLF_MAILCHIMP = `---------- Forwarded message ---------
From: Maine Lobster Festival <info@mainelobsterfestival.com>
View this email in your browser <https://mailchi.mp/mainelobsterfestival/newsletter-123>
80th Maine Lobster Festival, Aug. 4-8, 2027, at Harbor Park in Rockland, Maine.
Thank you to our sponsors. Read our blog <https://mainelobsterfestival.us8.list-manage.com/track/click?u=1&id=2>
Copyright (C) 2026 Maine Lobster Festival. All rights reserved.
You are receiving this email because you opted in via our website.
Want to change how you receive these emails? You can update your preferences or unsubscribe from this list.`;

/** 41f6896e — Joyce's Craft Shows, Brevo (the first draft of the rule missed it). */
const JOYCES_BREVO = `Next 2 Craft Fairs ... or Preview online at joycescraftshows.com <https://p4gof.r.ag.d.sendibm3.com/mk/cl/f/sh/6rqJ> - See you there!
If you wish to unsubscribe from our newsletter, click here <https://p4gof.r.ag.d.sendibm3.com/mk/un/v2/sh/6rq>`;

/** 0cb048f4 — a vendor's Constant Contact send; links did not survive the forward. */
const CENTRAL_COATING_CC = `Come Visit Us at the 2026 D2P New England Trade Show Sept. 30th and Oct. 1st! Visit us at Booth 510
Central Coating Technologies | 165 Shrewsbury Street | West Boylston, MA 01583 US
Unsubscribe | Update Profile | Constant Contact Data Notice`;

describe("detectNewsletter — the measured rule", () => {
  it("ACCEPTANCE (24c583d5): the Maine Lobster Festival Mailchimp forward is a newsletter", () => {
    const v = detectNewsletter(MLF_MAILCHIMP, null);
    expect(v.isNewsletter).toBe(true);
    expect(v.markers).toEqual(
      expect.arrayContaining([
        "esp:list-manage.com",
        "esp:mailchi.mp",
        "bulk:browser",
        "bulk:unsubscribe",
      ])
    );
  });

  it("Brevo (Joyce's) and a Constant Contact footer-only send are newsletters too", () => {
    expect(detectNewsletter(JOYCES_BREVO, null).isNewsletter).toBe(true);
    expect(detectNewsletter(CENTRAL_COATING_CC, null).markers).toContain(
      "esp-footer:constant contact data notice"
    );
    expect(detectNewsletter(CENTRAL_COATING_CC, null).isNewsletter).toBe(true);
  });

  it("an ESP marker is REQUIRED: a personal email quoting 'unsubscribe' is not a newsletter", () => {
    const personal =
      "Hi John — the fair is Aug 4-8. PS: I tried to unsubscribe from their list but it didn't work. Update your preferences, they said!";
    expect(detectNewsletter(personal, null)).toMatchObject({ isNewsletter: false });
  });

  it("…and an ESP marker alone (a tracker link someone pasted) is not a newsletter either", () => {
    const pasted =
      "Here's the fair page: https://mainelobsterfestival.us8.list-manage.com/track/click?u=1";
    expect(detectNewsletter(pasted, null).isNewsletter).toBe(false);
  });

  it("a plain event submission with a shortener link is not a newsletter", () => {
    expect(
      detectNewsletter("Our craft fair is Nov 7 at the Grange. Details: https://bit.ly/abc", null)
        .isNewsletter
    ).toBe(false);
  });
});

const MLF = {
  id: "e892bbce-780c-48a6-9143-14f644ca7f1f",
  companyName: "Maine Lobster Festival",
  website: "https://mainelobsterfestival.com",
  contactEmail: null,
};
const MAINE_MADE = {
  id: "mm-1",
  companyName: "Maine Made Marketplace",
  website: "https://mainemade.com",
  contactEmail: "hello@mainemade.com",
};

describe("attributeNewsletter — whose newsletter, and on what basis", () => {
  it("ACCEPTANCE (24c583d5): info@mainelobsterfestival.com → promoter e892bbce by sender domain", () => {
    expect(
      attributeNewsletter({ senderAddress: "info@mainelobsterfestival.com", text: MLF_MAILCHIMP }, [
        MLF,
        MAINE_MADE,
      ])
    ).toEqual({ promoterId: MLF.id, basis: "sender-domain" });
  });

  it("a shared ESP sending domain is never evidence (info@mainemade.ccsend.com ≠ any ccsend customer)", () => {
    const r = attributeNewsletter({ senderAddress: "info@mainemade.ccsend.com", text: "news" }, [
      { ...MAINE_MADE, website: "https://ccsend.com" },
    ]);
    expect(r.basis).toBe("unmatched");
  });

  it("the promoter's own contact email wins over the domain", () => {
    expect(
      attributeNewsletter({ senderAddress: "hello@mainemade.com", text: "" }, [MAINE_MADE])
    ).toEqual({ promoterId: "mm-1", basis: "contact-email" });
  });

  it("footer name: exactly one promoter named in the footer", () => {
    const footer = "...lots of news...\nCopyright 2026 Maine Made Marketplace, Portland ME";
    expect(attributeNewsletter({ senderAddress: null, text: footer }, [MAINE_MADE, MLF])).toEqual({
      promoterId: "mm-1",
      basis: "footer-name",
    });
  });

  it("two promoters named in the footer → unmatched (a wrong attribution is worse than none)", () => {
    const footer = "Maine Made Marketplace and Maine Lobster Festival thank our sponsors";
    expect(
      attributeNewsletter({ senderAddress: null, text: footer }, [MAINE_MADE, MLF]).basis
    ).toBe("unmatched");
  });

  it("a lists+<slug>@ arrival's promoter (OPE-1265) outranks everything", () => {
    expect(
      attributeNewsletter(
        { senderAddress: "hello@mainemade.com", text: "", subscriptionPromoterId: MLF.id },
        [MAINE_MADE]
      )
    ).toEqual({ promoterId: MLF.id, basis: "subscription-address" });
  });
});

describe("classifyAndRecordNewsletter — what the workflow step writes", () => {
  let db: TestDb;
  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(promoters)
      .values({
        id: MLF.id,
        companyName: MLF.companyName,
        slug: "maine-lobster-festival",
        website: MLF.website,
      } as never)
      .run();
  });
  const seed = (id: string, body: string, original: string | null) =>
    db
      .insert(inboundEmails)
      .values({
        id,
        receivedAt: new Date(),
        createdAt: new Date(),
        fromAddress: "jtarboxme@gmail.com",
        toAddress: "submit@meetmeatthefair.com",
        bodyText: body,
        originalSenderAddress: original,
        intent: "submit",
        status: "received",
        attachmentCount: 0,
      } as never)
      .run();
  const steps = () =>
    db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.stepName, "newsletter/classify"))
      .all();

  it("ACCEPTANCE (24c583d5): a forwarded newsletter is recorded with its promoter, by the ORIGINAL sender", async () => {
    seed("ie-mlf", MLF_MAILCHIMP, "info@mainelobsterfestival.com");
    const r = await classifyAndRecordNewsletter(db as never, "ie-mlf", "wf-1");
    expect(r).toEqual({ isNewsletter: true, basis: "sender-domain", promoterId: MLF.id });
    const [row] = db.select().from(inboundNewsletters).all();
    expect(row).toMatchObject({
      inboundEmailId: "ie-mlf",
      promoterId: MLF.id,
      matchBasis: "sender-domain",
      senderAddress: "info@mainelobsterfestival.com",
      itemsJson: null,
    });
    expect(steps()).toHaveLength(1);
  });

  it("a non-newsletter writes NO newsletter row but STILL records the step (the heartbeat's evidence)", async () => {
    seed("ie-plain", "Our craft fair is Nov 7 at the Grange.", null);
    const r = await classifyAndRecordNewsletter(db as never, "ie-plain", "wf-2");
    expect(r.isNewsletter).toBe(false);
    expect(db.select().from(inboundNewsletters).all()).toHaveLength(0);
    expect(steps()).toHaveLength(1);
    expect(JSON.parse(steps()[0].detail ?? "{}")).toMatchObject({ isNewsletter: false });
  });

  it("is idempotent on a workflow replay (one newsletter row per inbound email)", async () => {
    seed("ie-mlf", MLF_MAILCHIMP, "info@mainelobsterfestival.com");
    await classifyAndRecordNewsletter(db as never, "ie-mlf", "wf-1");
    await classifyAndRecordNewsletter(db as never, "ie-mlf", "wf-1");
    expect(db.select().from(inboundNewsletters).all()).toHaveLength(1);
  });
});

describe("the workflow never sends a single-event ack for a newsletter (source-level)", () => {
  const WF = readFileSync(`${__dirname}/../src/workflows/inbound-email.ts`, "utf8");
  it("the classify step runs before every reply guard and before send-reply, and suppresses", () => {
    const step = WF.indexOf('"newsletter/classify",');
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(WF.indexOf('"reply-guard/zero-confidence-unclear"'));
    expect(step).toBeLessThan(WF.indexOf('"send-reply",'));
    const after = WF.slice(step, step + 1500);
    expect(after).toMatch(/if \(newsletter\.isNewsletter && result\.replyKind !== null/);
    expect(after).toContain("suppressReply: true");
  });
});
