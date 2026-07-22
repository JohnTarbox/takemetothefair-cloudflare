/**
 * OPE-231 — /api/newsletter/approve POST guard rails.
 *
 * This endpoint fires a LIVE CUSTOMER BROADCAST, so the tests are about the
 * refusals: an invalid/expired token, a missing or already-sent issue, the
 * disabled flag, and the single-use latch all must send ZERO mail. Only a valid
 * token + pending issue + enabled flag + a won latch enqueues.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signApproveToken } from "@/lib/email/newsletter-approve-token";

const enqueueEmailMock = vi.fn(async (_job?: unknown) => {});
const selectMock = vi.fn();
const updateMock = vi.fn();
let sendEnabled = "true";

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({ select: selectMock, update: updateMock })),
  getCloudflareEnv: vi.fn(() => ({
    NEWSLETTER_SEND_ENABLED: sendEnabled,
    AUTH_SECRET: SECRET,
    MAILING_ADDRESS: "18 Main St, Phillips, ME 04966",
  })),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: (j: unknown) => enqueueEmailMock(j) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const SECRET = "approve-secret";
const { POST } = await import("../route");

/** Mock: first select → issue row; used for both the issue lookup and, in the
 *  broadcast branch, the recipient + suppression selects. Configured per test. */
function mockIssue(row: { subject: string; html: string; sentAt: Date | null } | null) {
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
  });
}

/** Mock the recipient + suppression selects used by selectBroadcastRecipients. */
function mockRecipients(emails: string[]) {
  selectMock
    .mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(emails.map((email) => ({ email }))) }),
    })
    .mockReturnValueOnce({ from: () => Promise.resolve([]) });
}

/** Mock the single-use latch UPDATE … RETURNING. `won` = we claimed the issue. */
function mockLatch(won: boolean) {
  updateMock.mockReturnValue({
    set: () => ({
      where: () => ({ returning: () => Promise.resolve(won ? [{ slug: "s" }] : []) }),
    }),
  });
}

async function postToken(token: string) {
  const form = new URLSearchParams({ token });
  const req = new NextRequest("http://localhost/api/newsletter/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return POST(req);
}

function statusOf(res: Response): string {
  const loc = res.headers.get("location") ?? "";
  return new URL(loc).searchParams.get("status") ?? "";
}

beforeEach(() => {
  enqueueEmailMock.mockClear();
  selectMock.mockReset();
  updateMock.mockReset();
  sendEnabled = "true";
});

const goodToken = () => signApproveToken("weekend-digest-2026-07-25", SECRET);

describe("POST /api/newsletter/approve — refusals send nothing", () => {
  it("303 invalid + no send on a missing token", async () => {
    const res = await postToken("");
    expect(res.status).toBe(303);
    expect(statusOf(res)).toBe("invalid");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("303 invalid + no send on a forged/garbage token", async () => {
    const res = await postToken("not-a-real-token");
    expect(statusOf(res)).toBe("invalid");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("303 invalid on an expired token (verify enforces TTL)", async () => {
    // Mint already-expired by signing far in the past.
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    const token = await signApproveToken("issue", SECRET, past);
    const res = await postToken(token);
    expect(statusOf(res)).toBe("invalid");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("303 not_found when the issue does not exist", async () => {
    mockIssue(null);
    const res = await postToken(await goodToken());
    expect(statusOf(res)).toBe("not_found");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("303 already_sent when the issue was already broadcast", async () => {
    mockIssue({ subject: "x", html: "<p>x</p>", sentAt: new Date() });
    const res = await postToken(await goodToken());
    expect(statusOf(res)).toBe("already_sent");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("303 disabled + no send when NEWSLETTER_SEND_ENABLED is off", async () => {
    sendEnabled = "false";
    mockIssue({ subject: "x", html: "<p>x</p>", sentAt: null });
    const res = await postToken(await goodToken());
    expect(statusOf(res)).toBe("disabled");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("303 already_sent + no send when the single-use latch is lost (race/replay)", async () => {
    mockIssue({ subject: "x", html: "<p>x</p>", sentAt: null });
    mockLatch(false); // a concurrent POST already flipped sent_at
    const res = await postToken(await goodToken());
    expect(statusOf(res)).toBe("already_sent");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/newsletter/approve — the happy path", () => {
  it("broadcasts the stored issue to the list once the latch is won", async () => {
    mockIssue({ subject: "Weekend Digest", html: "<p>fairs</p>", sentAt: null });
    mockLatch(true);
    mockRecipients(["a@x.com", "b@x.com"]);

    const res = await postToken(await goodToken());
    expect(res.status).toBe(303);
    expect(statusOf(res)).toBe("sent");
    expect(new URL(res.headers.get("location")!).searchParams.get("count")).toBe("2");
    expect(enqueueEmailMock).toHaveBeenCalledTimes(2);

    // The broadcast must NOT carry the approve button.
    const html = (enqueueEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("<p>fairs</p>");
    expect(html).not.toContain("Approve &amp; send to everyone");
  });
});
