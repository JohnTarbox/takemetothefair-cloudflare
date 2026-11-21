/**
 * OPE-1568 — `ingest_gsc_milestone_email` must SHOW a monthly-oracle result.
 *
 * The main-app endpoint has parsed Google's monthly "Search performance" report
 * since OPE-344, but this tool's success payload only forwarded milestone
 * fields. For a monthly report every one of them is undefined, so the caller saw
 * a bare `{"success":true}` — a confident answer naming nothing it did. That,
 * plus a description that only spoke milestones, is how an analyst lane
 * concluded it could not clear the red `gsc-monthly-oracle` heartbeat.
 */
import { describe, it, expect, vi } from "vitest";

let respond: () => Response = () => {
  throw new Error("test did not set a response");
};
vi.mock("../src/main-app-fetch.js", () => ({
  mainAppFetch: () => respond(),
}));

const { registerGscMilestoneIngestTool } =
  await import("../src/tools/admin-gsc-milestone-ingest.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collect(): { handler: any; description: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any = null;
  let description = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server: any = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (_name: string, desc: string, ...rest: any[]) => {
      description = desc;
      handler = rest[rest.length - 1];
    },
  };
  registerGscMilestoneIngestTool(server, { role: "ADMIN" } as never, {
    MAIN_APP_URL: "https://example.test",
    INTERNAL_API_KEY: "k",
  });
  return { handler, description };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ingest_gsc_milestone_email — monthly oracle (OPE-1568)", () => {
  it("passes the monthly result through instead of a bare success", async () => {
    respond = () =>
      json({
        success: true,
        kind: "monthly_oracle",
        month: "2026-09",
        oracle: { clicks: 27900, impressions: 1650000 },
        comparison: {
          api_clicks: 27850,
          dimensioned_clicks: 9000,
          api_divergence: 0.0018,
          alarmed: false,
        },
      });
    const { handler } = collect();
    const res = await handler({
      subject: "Your September Search performance for meetmeatthefair.com",
      body: "…",
      email_date: "2026-10-06T13:12:19Z",
    });
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0].text);
    expect(out).toMatchObject({
      success: true,
      kind: "monthly_oracle",
      month: "2026-09",
      oracle: { clicks: 27900, impressions: 1650000 },
      comparison: { api_divergence: 0.0018, alarmed: false },
    });
  });

  it("still returns the milestone shape for a milestone email", async () => {
    respond = () =>
      json({
        success: true,
        inserted: true,
        milestone: { threshold: 3000 },
        note: "Milestone recorded.",
      });
    const { handler } = collect();
    const res = await handler({
      subject: "Congrats on reaching 3K clicks in 28 days!",
      email_date: "2026-07-06",
    });
    const out = JSON.parse(res.content[0].text);
    expect(out).toEqual({
      success: true,
      inserted: true,
      milestone: { threshold: 3000 },
      note: "Milestone recorded.",
    });
  });

  it("advertises the monthly report in its description", () => {
    const { description } = collect();
    expect(description).toMatch(/Search performance/);
    expect(description).toMatch(/gsc-monthly-oracle/);
  });
});
