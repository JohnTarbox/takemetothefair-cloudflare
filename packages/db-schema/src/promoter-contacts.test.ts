import { describe, it, expect } from "vitest";
import {
  contactSenderAuth,
  decidePromoterContactDomain,
  dmarcHeaderFrom,
  planPromoterContactWrite,
  type ExistingPromoterContact,
} from "./promoter-contacts";

const NOW = new Date("2026-10-06T22:00:00Z");
const EARLIER = new Date("2026-10-01T12:00:00Z");

describe("dmarcHeaderFrom", () => {
  it.each([
    [
      "mx; dkim=pass header.d=yahoo.com; dmarc=none header.from=garlicfestct.com policy.dmarc=none",
      "garlicfestct.com",
    ],
    ["mx; dmarc=pass (p=REJECT) header.from=Example.ORG; spf=pass", "example.org"],
    ["mx; spf=pass smtp.mailfrom=a@b.org", null],
    [null, null],
  ])("%j → %j", (raw, want) => expect(dmarcHeaderFrom(raw)).toBe(want));
});

describe("decidePromoterContactDomain — guards beyond the capture tests", () => {
  const facts = {
    fromAddress: "office@grangefair.org",
    dmarcResult: "pass",
    authResultsRaw: "mx; dmarc=pass header.from=grangefair.org",
    originalSenderAuth: "not_forwarded",
  };
  it("qualifies on the plain case (positive landmark)", () => {
    expect(decidePromoterContactDomain(facts, "https://grangefair.org").qualifies).toBe(true);
  });
  it("refuses when DMARC's header.from is a different organization than the From address", () => {
    const v = decidePromoterContactDomain(
      { ...facts, authResultsRaw: "mx; dmarc=pass header.from=other.org" },
      "https://other.org"
    );
    expect(v.qualifies).toBe(false);
    expect(v.reason).toContain("≠ From");
  });
  // The sender-side and website-side non-ownable checks each subsume the other
  // through the equality check, so the VERDICT alone cannot show either one is
  // alive. Pin each check's OWN effect: the reason it records.
  it("a free-mail SENDER is refused by the sender check (its own reason)", () => {
    const v = decidePromoterContactDomain(
      {
        ...facts,
        fromAddress: "fairfolks@gmail.com",
        authResultsRaw: "mx; dmarc=pass header.from=gmail.com",
      },
      "https://gmail.com"
    );
    expect(v).toMatchObject({
      qualifies: false,
      reason: "gmail.com is a shared or free-mail domain",
    });
  });
  it("a shared-host WEBSITE is refused by the website check (its own reason)", () => {
    const v = decidePromoterContactDomain(facts, "https://www.facebook.com/grangefair");
    expect(v).toMatchObject({ qualifies: false, reason: "website facebook.com is a shared host" });
  });
  it("matchesPromoter is null when the promoter has no website", () => {
    expect(decidePromoterContactDomain(facts, null)).toMatchObject({
      matchesPromoter: null,
      qualifies: false,
    });
  });
  it.each(["fail", "none", "temperror", null])("dmarc=%s never qualifies", (d) => {
    expect(
      decidePromoterContactDomain({ ...facts, dmarcResult: d }, "https://grangefair.org").qualifies
    ).toBe(false);
  });
  it("a NULL original_sender_auth (pre-capture row) does not qualify", () => {
    expect(
      decidePromoterContactDomain({ ...facts, originalSenderAuth: null }, "https://grangefair.org")
        .qualifies
    ).toBe(false);
  });
});

describe("contactSenderAuth", () => {
  it.each([
    ["pass", "pass"],
    ["partial", "partial"],
    ["fail", "fail"],
    ["unknown", null],
    [null, null],
  ])("%j → %j", (v, want) => expect(contactSenderAuth(v)).toBe(want));
});

describe("planPromoterContactWrite", () => {
  const base = {
    promoterId: "p1",
    email: "Jane@GrangeFair.org",
    fields: { validationMethod: "approved_claim" as const, status: "validated" as const },
    actor: "t",
    now: NOW,
  };
  const existing = (status: ExistingPromoterContact["status"]): ExistingPromoterContact => ({
    id: "k1",
    status,
    firstValidatedAt: status === "validated" ? EARLIER : null,
    lastHeardAt: EARLIER,
  });

  it("refuses a missing or malformed address", () => {
    expect(
      planPromoterContactWrite({ ...base, writer: "manual", existing: null, email: "nope" }).kind
    ).toBe("invalid");
  });
  it("an insert stores the address lowercased and stamps first_validated_at only when validated", () => {
    const p = planPromoterContactWrite({ ...base, writer: "claim", existing: null });
    expect(p).toMatchObject({
      kind: "insert",
      values: { email: "jane@grangefair.org", firstValidatedAt: NOW },
    });
    const c = planPromoterContactWrite({
      ...base,
      writer: "capture",
      existing: null,
      fields: { validationMethod: "replied_to_our_mail", status: "candidate" },
    });
    expect(c).toMatchObject({ kind: "insert", values: { firstValidatedAt: null } });
  });
  it("claim: never overrides a human's rejection", () => {
    expect(
      planPromoterContactWrite({ ...base, writer: "claim", existing: existing("rejected") }).kind
    ).toBe("noop");
  });
  it("claim: promotes a candidate and keeps an earlier first_validated_at", () => {
    const p = planPromoterContactWrite({
      ...base,
      writer: "claim",
      existing: existing("candidate"),
    });
    expect(p).toMatchObject({
      kind: "update",
      promoted: true,
      set: { status: "validated", firstValidatedAt: NOW },
    });
    const again = planPromoterContactWrite({
      ...base,
      writer: "claim",
      existing: existing("validated"),
    });
    expect(again.kind).toBe("noop");
  });
  it("capture: a later message never moves last_heard_at backwards", () => {
    const p = planPromoterContactWrite({
      ...base,
      writer: "capture",
      existing: existing("candidate"),
      fields: { validationMethod: "replied_to_our_mail", status: "candidate" },
      heardAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(p.kind).toBe("noop");
  });
  it("manual: a human can set any status, including un-rejecting", () => {
    const p = planPromoterContactWrite({
      ...base,
      writer: "manual",
      existing: existing("rejected"),
      fields: { validationMethod: "phone", status: "validated" },
    });
    expect(p).toMatchObject({
      kind: "update",
      set: { status: "validated", validationMethod: "phone", firstValidatedAt: NOW },
    });
  });
});
