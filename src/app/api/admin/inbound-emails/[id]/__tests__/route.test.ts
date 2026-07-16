/**
 * OPE-205 §2 — the detail route now returns the booth identifications OPE-204
 * staged for this email. These tests pin the parsing, because the payload is
 * free-form JSON written by another Worker: a shape change there must surface as
 * a visible gap here, never as a silently dropped identification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
let emailRows: unknown[] = [];
let proposalRows: unknown[] = [];
let eventRows: unknown[] = [];

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => {
    // Call order in the route: 1) the email (…limit), 2) the proposals
    // (…orderBy), 3) the event name (…limit).
    let call = 0;
    return {
      select: () => {
        call++;
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(call === 1 ? emailRows : eventRows),
              orderBy: () => Promise.resolve(proposalRows),
            }),
          }),
        };
      },
    };
  },
}));

import { GET } from "../route";

const req = () =>
  new NextRequest("http://localhost/api/admin/inbound-emails/e1", { method: "GET" });
const params = { params: Promise.resolve({ id: "e1" }) };

interface DetailBody {
  boothProposals: Array<{
    id: string;
    photoKey: string | null;
    businessName: string | null;
    confidence: number | null;
    rationale: string | null;
    wouldAutoWrite: boolean;
    stageReason: string | null;
  }>;
  proposalEvent: { id: string; name: string; slug: string } | null;
}

/** `Response.json()` is `unknown`; the route's shape is asserted below. */
const detail = async (): Promise<DetailBody> =>
  (await GET(req(), params)).json() as Promise<DetailBody>;

const email = {
  id: "e1",
  receivedAt: new Date("2026-07-15T12:00:00Z"),
  fromAddress: "john@pimboat.com",
  subject: "booths",
  bodyText: null,
  bodyHtml: null,
  bodyTextExcerpt: null,
  rawSize: 1,
  attachmentRefs: null,
};

const proposal = (payload: unknown, id = "p1") => ({
  id,
  createdAt: new Date("2026-07-15T12:01:00Z"),
  payloadJson: typeof payload === "string" ? payload : JSON.stringify(payload),
});

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { role: "ADMIN" } });
  emailRows = [email];
  proposalRows = [];
  eventRows = [];
});

describe("GET /api/admin/inbound-emails/[id] — booth proposals (OPE-205 §2)", () => {
  it("is admin-only", async () => {
    authMock.mockResolvedValue({ user: { role: "USER" } });
    expect((await GET(req(), params)).status).toBe(401);
  });

  it("returns an empty list for an email with no identifications", async () => {
    const body = await detail();
    expect(body.boothProposals).toEqual([]);
    expect(body.proposalEvent).toBeNull();
  });

  it("surfaces a staged identification with its confidence and rationale", async () => {
    proposalRows = [
      proposal({
        event_id: "evt-1",
        photo_key: "inbound-attachments/e1/0-a.jpg",
        photo_name: "a.jpg",
        business_name: "Maple Hollow Farm",
        website: "https://maple.example",
        products: ["syrup"],
        confidence: 0.91,
        rationale: "banner on the stall",
        would_auto_write: true,
        stage_reason: null,
      }),
    ];
    eventRows = [{ id: "evt-1", name: "Fryeburg Fair", slug: "fryeburg-fair" }];

    const body = await detail();
    expect(body.boothProposals).toHaveLength(1);
    const p = body.boothProposals[0];
    expect(p.businessName).toBe("Maple Hollow Farm");
    expect(p.confidence).toBe(0.91);
    expect(p.rationale).toBe("banner on the stall");
    expect(p.wouldAutoWrite).toBe(true);
    // The reviewer sees the fair by name, not an opaque id.
    expect(body.proposalEvent).toEqual({
      id: "evt-1",
      name: "Fryeburg Fair",
      slug: "fryeburg-fair",
    });
  });

  it("distinguishes a held identification from a would-auto-write one", async () => {
    proposalRows = [
      proposal({
        business_name: "Unclear Signage Co",
        confidence: 0.4,
        would_auto_write: false,
        stage_reason: "low confidence",
      }),
    ];
    const body = await detail();
    expect(body.boothProposals[0].wouldAutoWrite).toBe(false);
    expect(body.boothProposals[0].stageReason).toBe("low confidence");
  });

  it("still lists an identification whose payload is malformed", async () => {
    // Hiding it would hide the fact that a photo WAS identified — the reviewer
    // needs to see the row even when we can't read what's in it.
    proposalRows = [proposal("{not json", "p-bad")];
    const body = await detail();
    expect(body.boothProposals).toHaveLength(1);
    expect(body.boothProposals[0].id).toBe("p-bad");
    expect(body.boothProposals[0].businessName).toBeNull();
  });

  it("reports a photo the vision model couldn't identify", async () => {
    proposalRows = [proposal({ photo_key: "k", business_name: null, would_auto_write: false })];
    const body = await detail();
    expect(body.boothProposals[0].businessName).toBeNull();
    expect(body.boothProposals[0].photoKey).toBe("k");
  });

  it("404s an unknown email", async () => {
    emailRows = [];
    expect((await GET(req(), params)).status).toBe(404);
  });
});
