/**
 * OPE-163 — /api/admin/inbound-emails/[id]/reply guard rails: admin-only, the
 * EMAIL_REPLY_ENABLED flag (409 when off), and body validation. In every refuse
 * case nothing is enqueued. The DB-dependent reply logic (subject/html/
 * threading/suppression/status) is shared with — and covered by — the
 * handleReplyToInbound unit tests in mcp-server.
 *
 * OPE-368 (R4) — the flag gate no longer runs "before any DB access". It could
 * not: refusing before the body was parsed is precisely why the operator's
 * prose was discarded. The route now resolves the inbound row, builds the
 * draft, PERSISTS it, and only then refuses. Same 409, same "nothing enqueued";
 * the answer somebody wrote now survives the refusal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
const enqueueEmailMock = vi.fn(async () => {});
let replyEnabled = "false";

// OPE-368 — the refusal path now reads the inbound row and writes a draft, so
// the db stub has to support both. `inserted` is the assertion target for "the
// draft survived", which is the whole point of the ticket.
const inserted: unknown[] = [];
// The route makes TWO selects in order: the inbound row, then the suppression
// lookup. A stub that answers both identically reports every sender as
// suppressed, so the sequence matters.
let selectCall = 0;
const dbStub = {
  select: () => {
    const call = selectCall++;
    return {
      from: () => ({
        where: () => ({
          limit: async () =>
            call === 0
              ? [
                  {
                    id: "inb-1",
                    fromAddress: "katie@example.com",
                    subject: "hours",
                    messageId: "<m1>",
                  },
                ]
              : [], // not suppressed
        }),
      }),
    };
  },
  insert: () => ({
    values: async (v: unknown) => {
      inserted.push(v);
    },
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => dbStub),
  getCloudflareEnv: vi.fn(() => ({ EMAIL_REPLY_ENABLED: replyEnabled })),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: () => enqueueEmailMock() }));
vi.mock("@/lib/logger", () => ({ logError: async () => undefined }));

import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/inbound-emails/inb-1/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ id: "inb-1" });

beforeEach(() => {
  authMock.mockReset();
  enqueueEmailMock.mockClear();
  inserted.length = 0;
  selectCall = 0;
  replyEnabled = "false";
});

describe("POST /api/admin/inbound-emails/[id]/reply — guard rails (OPE-163)", () => {
  it("401 for a non-admin; nothing enqueued", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req({ body: "hi" }), { params });
    expect(res.status).toBe(401);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("409 when replies are disabled (flag off); nothing enqueued", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    replyEnabled = "false";
    const res = await POST(req({ body: "hi" }), { params });
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("reply_disabled");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("OPE-368: the refused draft is PERSISTED, not discarded", async () => {
    // The defect: on 2026-08-10 an agent reported a reply "was blocked" and
    // nobody could say what had become of the text. A refusal that destroys the
    // work is indistinguishable from a crash.
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    replyEnabled = "false";
    const res = await POST(req({ body: "Yes — the fair runs both days." }), { params });

    expect(res.status).toBe(409);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    const draft = inserted[0] as Record<string, unknown>;
    expect(draft.bodyText).toBe("Yes — the fair runs both days.");
    expect(draft.toAddress).toBe("katie@example.com");
    expect(draft.status).toBe("pending");

    // And the caller is told where it went — the old message said only
    // "disabled", which is why the refusal could not be followed up.
    const j = (await res.json()) as { draftId?: string; message: string };
    expect(j.draftId).toBeTruthy();
    expect(j.message).toContain(j.draftId as string);
  });

  it("400 when enabled but body is empty; nothing enqueued", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    replyEnabled = "true";
    const res = await POST(req({ body: "   " }), { params });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("missing_body");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});
