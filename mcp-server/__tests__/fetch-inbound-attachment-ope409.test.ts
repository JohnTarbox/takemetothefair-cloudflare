/**
 * OPE-409 step 2 — the agent-callable recovery path.
 *
 * This tool is the precondition for closing the public `inbound-attachments/`
 * CDN prefix. Once that prefix is shut, the only route to an attachment's bytes
 * is an admin session or the `X-Internal-Key` that only our own Workers hold —
 * neither of which an agent has. Closing the public path without this would
 * trade a low-severity exposure for a real operational loss: the ability to
 * rescue photos the pipeline drops.
 *
 * Three behaviours are pinned because each one, wrong, produces a confident
 * wrong answer rather than an error:
 *
 *   - 401 must not read as "no such attachment". A rejected internal key is a
 *     deployment fault; reporting it as 404 sends the next agent looking for a
 *     file that is sitting right there. That exact inference — "no tool returns
 *     the bytes, therefore unrecoverable" — cost a live repair on 2026-08-21.
 *   - Oversized attachments are WITHHELD, never truncated. Truncated base64
 *     decodes to a corrupt file that looks like a real answer.
 *   - An unconfigured Worker says so, rather than failing as if the attachment
 *     were missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A plain stub rather than `vi.fn()`, deliberately.
 *
 * One of these cases needs the transport to FAIL, and a vi.fn spy records the
 * rejection in its `results` and reports it as an error the test did not
 * handle — even though the handler catches it and returns cleanly (verified
 * output: `{"ok":false,"error":"fetch-failed"}`). Fighting that with
 * `mockClear`, sync throws, or a no-op `.catch` on a derived promise all failed;
 * the tracking is on the spy, not on the promise. A stub has no result
 * tracking, so the harness stops editorialising and the assertions still hold.
 */
let impl: (...a: unknown[]) => unknown = () => {
  throw new Error("test did not set an implementation");
};
const calls: unknown[][] = [];
vi.mock("../src/main-app-fetch.js", () => ({
  mainAppFetch: (...a: unknown[]) => {
    calls.push(a);
    return impl(...a);
  },
}));

const { registerInboundReadTools } = await import("../src/tools/admin-inbound-read.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collect(env: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server: any = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, ...rest: any[]) => tools.set(name, rest[rest.length - 1]),
  };
  registerInboundReadTools(server, {} as never, { role: "ADMIN", userId: "u1" } as never, env);
  return tools;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(tools: Map<string, any>, args: Record<string, unknown>) {
  const out = await tools.get("fetch_inbound_attachment")(args);
  return JSON.parse(out.content[0].text);
}

const ENV = { INTERNAL_API_KEY: "k", MAIN_APP_URL: "https://meetmeatthefair.com" };

beforeEach(() => (calls.length = 0));

describe("fetch_inbound_attachment", () => {
  it("returns the bytes as base64 with name and type", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    impl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-disposition": 'inline; filename="poster.png"',
      }),
      arrayBuffer: async () => body.buffer,
    });

    const out = await call(collect(ENV), { inbound_email_id: "e1", index: 0 });
    expect(out.ok).toBe(true);
    expect(out.inlined).toBe(true);
    expect(out.content_type).toBe("image/png");
    expect(out.filename).toBe("poster.png");
    expect(out.size).toBe(5);
    // Round-trips: the bytes are the real ones, not a placeholder.
    expect([...atob(out.base64)].map((c) => c.charCodeAt(0))).toEqual([1, 2, 3, 4, 5]);
  });

  it("calls the admin route for the requested email and index", async () => {
    impl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([0]).buffer,
    });

    await call(collect(ENV), { inbound_email_id: "abc-123", index: 2 });
    expect(calls[0][1]).toBe("/api/admin/inbound-emails/abc-123/attachments/2");
  });

  it("distinguishes a rejected internal key from a missing attachment", async () => {
    // The load-bearing one. A 401 reported as "not found" is what turns a
    // deployment fault into "this attachment is unrecoverable".
    impl = async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "Unauthorized",
    });

    const out = await call(collect(ENV), { inbound_email_id: "e1", index: 0 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("http-401");
    expect(out.detail).toMatch(/configuration fault/i);
    // It must NOT be reported the way a genuine 404 is.
    expect(out.error).not.toBe("http-404");
    expect(out.detail).not.toMatch(/no attachment at that index/i);
  });

  it("reports a genuine 404 as a missing attachment", async () => {
    impl = async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "",
    });

    const out = await call(collect(ENV), { inbound_email_id: "e1", index: 9 });
    expect(out.error).toBe("http-404");
    expect(out.detail).toMatch(/no attachment at that index/i);
  });

  it("withholds oversized bytes and hands back a download URL instead", async () => {
    // OPE-409 — over the cap used to be a dead end: `{ok:true, inlined:false}`
    // and nothing else. That branch fires for 52 of 88 stored attachments
    // (59%), including all five of the reference-case photos at 3.67-5.49 MB,
    // so the recovery path declined the majority of what it exists to recover.
    const big = new Uint8Array(1_500_001);
    impl = async (_env: unknown, path: string) => {
      if (typeof path === "string" && path.includes("attachment-download-slot")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            download_url: "https://meetmeatthefair.com/api/admin/inbound-attachment/tok123",
            expires_at: "2026-08-24T04:00:00.000Z",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => big.buffer,
      };
    };

    const out = await call(collect(ENV), { inbound_email_id: "e1", index: 0 });
    expect(out.ok).toBe(true);
    expect(out.inlined).toBe(false);
    expect(out.reason).toBe("too-large");
    expect(out.size).toBe(1_500_001);
    // A partial blob would decode to a corrupt file that looks like an answer.
    expect(out.base64).toBeUndefined();
    expect(out.download_url).toBe(
      "https://meetmeatthefair.com/api/admin/inbound-attachment/tok123"
    );
    expect(out.expires_at).toBe("2026-08-24T04:00:00.000Z");
    // Not the CDN: the URL has to survive the inbound-attachments lockdown.
    expect(out.download_url).not.toMatch(/cdn\.meetmeatthefair\.com/);
  });

  it("says plainly when the slot could not be minted, instead of implying a size limit", async () => {
    // The two outcomes demand different responses — "too big to inline, here is
    // the URL" versus "this attachment is currently unreachable by any agent" —
    // and rendering them identically is the failure mode this whole ticket is
    // about. A refusal that reports success is what left 59% of the archive
    // looking recoverable.
    const big = new Uint8Array(2_000_000);
    impl = async (_env: unknown, path: string) => {
      if (typeof path === "string" && path.includes("attachment-download-slot")) {
        return { ok: false, status: 503, headers: new Headers(), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => big.buffer,
      };
    };

    const out = await call(collect(ENV), { inbound_email_id: "e1", index: 0 });
    expect(out.ok).toBe(true);
    expect(out.inlined).toBe(false);
    expect(out.download_url).toBeNull();
    expect(out.note).toMatch(/unreachable programmatically/i);
    expect(out.note).toMatch(/fault worth reporting/i);
  });

  it("says so when the Worker has no route to the main app", async () => {
    const out = await call(collect({}), { inbound_email_id: "e1", index: 0 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("reports a transport failure as itself, not as a missing file", async () => {
    impl = async () => {
      throw new Error("binding blew up");
    };
    const out = await call(collect(ENV), { inbound_email_id: "e1", index: 0 });
    expect(out.error).toBe("fetch-failed");
    expect(out.detail).toMatch(/binding blew up/);
  });
});
