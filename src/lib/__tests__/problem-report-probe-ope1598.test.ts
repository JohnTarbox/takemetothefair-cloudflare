import { describe, expect, it } from "vitest";
import { isInjectionProbe } from "../problem-report-probe";

/** One of each shape seen in production on 2026-10-21 and 2026-11-06. */
const OBSERVED_PROBES = [
  "ORDER BY 1-- -",
  "ORDER BY 1000-- -",
  "' ORDER BY 1000-- -",
  ")/**/AND/**/(645358935=645358935'",
  ")/**/and/**/(1483734071=1483734071'",
  "AND EXTRACTVALUE(1481,CONCAT(0x7e,((SELECT (ELT(1481=1481,1)))),0x7e))-- -",
  "%' AND EXTRACTVALUE(8817,CONCAT(0x7e,((SELECT (ELT(8817=8817,1)))),0x7e))-- -",
  "UNION ALL SELECT 'nmtpobdvfhviudcoovvijiyceycvyzhs'-- ksg1p3",
  "UNION ALL SELECT NULL,'nmtpobdvfhviudcoovvijiyceycvyzhs'-- i4rehr",
  ")/**/AND/**/(381849632=381849632/**/UnioN/**/all/**/seLeCT/**/'nmtp'",
  ")/*!50000AND*/(576533778=576533778AND/**/EXTRACTVALUE(4208,/*!50000CONCAT*/(0x7e,1))",
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
];

/** The real reports open on 2026-11-09, and text built to look close. */
const REAL_REPORTS = [
  "The Dates are wrong. It should be Sept 12-13,2026. Promoter is Eastern Gun Expo.",
  "I am the promoter for this event this weekend. The show is scheduled for September 12th and 13th.",
  "I just tried to fill out my Vendor profile on your website and even when I hit 'save changes' nothing happens.",
  "[auto-detected from email — matched: isn't working]  I am on my PC, (windows) I was trying to sign up",
  "Claim evidence: someone@example.com for vendor comparion-insurance-agency-2",
  "The Union Fair page won't let me select a date.",
  "Please order by date, 1 or 2 events are out of place.",
  "The form said 1=1 row found and then it crashed",
];

describe("isInjectionProbe", () => {
  it.each(OBSERVED_PROBES)("flags %s", (body) => {
    expect(isInjectionProbe(body)).toBe(true);
  });

  it.each(REAL_REPORTS)("leaves %s alone", (body) => {
    expect(isInjectionProbe(body)).toBe(false);
  });
});
