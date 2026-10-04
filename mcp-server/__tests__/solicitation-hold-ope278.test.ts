/**
 * OPE-278 — attendee-list brokers and operator-BLOCKED senders are held on
 * receipt: no classifier, no workflow, no ack.
 *
 * The specimens are every broker email prod has ever received (5, measured
 * 2026-10-04). The near-misses are our own blog-mention notices, which carry
 * "Visitor's Guide" in the subject; 21 of them exist and none may be held.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideSolicitationHold,
  detectListBrokerSolicitation,
} from "../src/email-handlers/solicitation-hold.js";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

const SPECIMENS: Array<[string, string]> = [
  ["sara.beth.sovrago@gmail.com", "Complete Attendee Information for CraftFest Cotuit 2026"],
  [
    "lucy.morgan.leadstream@gmail.com",
    "Complete Visitor List for New England Made Giftware & Specialty Food Show 2026",
  ],
  [
    "charles.anderson.leadstream@gmail.com",
    "47th Annual Fall Connecticut Home Show 2026: Full List of Registered Visitors",
  ],
  ["mia.johsonn@gmail.com", "Norwalk Boat Show 2026 - Attendee List"],
];

const NEAR_MISSES = [
  '"Maine Whoopie Pie Festival 2026: Visitor\'s Guide" mentions Maine Whoopie Pie Festival 2026',
  'Re: Re: "Moxie Festival 2026: Visitor\'s Guide" mentions Moxie Festival 2026',
  "\"Craft Fairs in Maine 2026: A Vendor's and Visitor's Guide\" mentions Old Port Makers Market",
  "Vendor list for the Fryeburg Fair 2026",
  "Exhibitor list attached — Topsfield Fair",
  "Question about visitor parking",
  "Our attendees loved it — add us for 2027?",
];

describe("OPE-278 — the pattern rule", () => {
  it.each(SPECIMENS)("holds the real broker email from %s", (from, subject) => {
    expect(detectListBrokerSolicitation({ fromAddr: from, subject })?.kind).toBe("list-broker");
  });

  it("holds the same subject from a FRESH address — what an address block cannot do", () => {
    const v = detectListBrokerSolicitation({
      fromAddr: "olivia.harper2291@gmail.com",
      subject: "Big E 2026 - Attendee List",
    });
    expect(v).toEqual({ kind: "list-broker", reason: "list-broker:subject" });
  });

  it("holds a leadstream sender whatever the subject says", () => {
    expect(
      detectListBrokerSolicitation({
        fromAddr: "new.person-leadstream@gmail.com",
        subject: "Quick question",
      })
    ).toEqual({ kind: "list-broker", reason: "list-broker:sender-token:leadstream" });
  });

  it.each(NEAR_MISSES)("does NOT hold: %s", (subject) => {
    expect(detectListBrokerSolicitation({ fromAddr: "someone@example.org", subject })).toBeNull();
  });

  it("a token must be a whole local-part segment, not a substring", () => {
    expect(
      detectListBrokerSolicitation({ fromAddr: "leadstreamer@x.com", subject: "hello" })
    ).toBeNull();
  });
});

describe("OPE-278 — the operator block", () => {
  it("a blocked sender is held even with an innocent subject", () => {
    expect(
      decideSolicitationHold({
        senderTrust: "blocked",
        fromAddr: "john@provenroi.com",
        subject: "New fair for your calendar",
      })
    ).toEqual({ kind: "blocked-sender", reason: "blocked-sender:trust_status" });
  });

  it("the explicit block wins over the pattern, so the reason names the operator's decision", () => {
    const [from, subject] = SPECIMENS[0];
    expect(decideSolicitationHold({ senderTrust: "blocked", fromAddr: from, subject })?.kind).toBe(
      "blocked-sender"
    );
  });

  it.each(["unknown", "watchlist", "trusted"])(
    "%s is not a block — innocent mail passes, a broker subject is still held",
    (tier) => {
      expect(
        decideSolicitationHold({ senderTrust: tier, fromAddr: "a@b.org", subject: "Our fair" })
      ).toBeNull();
      expect(
        decideSolicitationHold({ senderTrust: tier, fromAddr: "a@b.org", subject: "Attendee List" })
          ?.kind
      ).toBe("list-broker");
    }
  );
});

describe("OPE-278 — wiring", () => {
  const handler = read("src/email-handler.ts");
  const hold = handler.indexOf("decideSolicitationHold({ senderTrust, subject, fromAddr })");

  it("the hold runs before the rate limit, the classifier and the workflow", () => {
    expect(hold).toBeGreaterThan(-1);
    const rate = handler.indexOf("const allowed = await checkSenderRateLimit(");
    const classify = handler.indexOf("await classifyIntent(env.AI, {");
    const workflow = handler.indexOf("const instance = await env.INBOUND_EMAIL.create({");
    expect(rate).toBeGreaterThan(hold);
    expect(classify).toBeGreaterThan(hold);
    expect(workflow).toBeGreaterThan(hold);
  });

  it("the held path stores a row and RETURNS", () => {
    const body = handler.slice(hold, handler.indexOf("// 2. Rate limit", hold));
    expect(body).toContain("await insertAuditNoopRow(getDb(env.DB), {");
    expect(body).toContain("routingSource: `solicitation:${solicitation.kind}`");
    expect(body).toMatch(/\n\s*return;\n\s*\}\s*$/);
  });

  it("the trust lookup happens exactly once, before the hold, and the fast-path reuses it", () => {
    const lookups = handler.match(
      /const senderTrust = await lookupSenderTrust\(env\.DB, fromAddr\);/g
    );
    expect(lookups).toHaveLength(1);
    expect(handler.indexOf("const senderTrust = await lookupSenderTrust(")).toBeLessThan(hold);
    expect(handler.indexOf('senderTrust === "trusted" && emailAuth !== "pass"')).toBeGreaterThan(
      hold
    );
  });
});
