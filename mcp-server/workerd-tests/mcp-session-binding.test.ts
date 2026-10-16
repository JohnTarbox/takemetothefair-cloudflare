/**
 * OPE-1391 — an MCP session belongs to the user who opened it.
 *
 * Runs the REAL agents@0.28.1 McpAgent.serve()/serveSSE() handlers against a
 * real SQLite-backed Durable Object (ProbeMCP, workerd-tests/probe-mcp.ts) in
 * workerd, wrapped exactly as src/index.ts wraps MeetMeAtTheFairMCP. `ctx.props`
 * is what OAuthProvider hands an apiHandler after validating a bearer token.
 *
 * Before the fix, user B's token + user A's session id ran as A on a warm
 * object, and on a cold one B's props overwrote A's stored props.
 */
import { describe, it, expect } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { bindMcpSessionsToUser, ownerBoundName, sessionOwnerTag } from "../src/mcp-session-binding";
import { ProbeMCP } from "./probe-mcp";
import type { WorkerdTestEnv } from "./env.js";

const env = workerEnv as unknown as WorkerdTestEnv;
const ORIGIN = "https://mcp.meetmeatthefair.com";
const PROTOCOL = "2025-06-18";

const mcp = bindMcpSessionsToUser(ProbeMCP.serve("/mcp"));
const sse = bindMcpSessionsToUser(ProbeMCP.serveSSE("/sse"));

let seq = 0;
const freshUser = (label: string) => `${label}-${Date.now()}-${++seq}`;

function ctxFor(userId: string | undefined): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: userId === undefined ? {} : { userId },
  } as unknown as ExecutionContext;
}

async function readAll(res: Response, ms = 5000): Promise<string> {
  return await Promise.race([
    res.text(),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("stream timeout")), ms)),
  ]);
}

function post(userId: string, body: unknown, sessionId?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = PROTOCOL;
  }
  return mcp.fetch(
    new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }),
    env as never,
    ctxFor(userId)
  );
}

async function openSession(userId: string): Promise<string> {
  const res = await post(userId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "ope-1391-test", version: "1" },
    },
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  expect(await readAll(res)).toContain('"protocolVersion"');
  const ack = await post(userId, { jsonrpc: "2.0", method: "notifications/initialized" }, sid!);
  expect(ack.status).toBe(202);
  return sid!;
}

/** tools/call whoami → { status, userId } (userId only when the call ran). */
async function whoami(userId: string, sessionId: string) {
  const res = await post(
    userId,
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "whoami", arguments: {} } },
    sessionId
  );
  const text = await readAll(res);
  const m = text.match(/\\"userId\\":(null|\\"([^\\]*)\\")/);
  return { status: res.status, userId: m ? (m[2] ?? null) : undefined, text };
}

async function storedProps(name: string, userId: string) {
  const stub = env.MCP_OBJECT.get(
    env.MCP_OBJECT.idFromName(ownerBoundName(name, await sessionOwnerTag(userId)))
  );
  return runInDurableObject(stub, (_i, state) => state.storage.get<{ userId: string }>("props"));
}

describe("OPE-1391 — streamable HTTP session binding", () => {
  it("the session's own user can use it (initialize → tools/call)", async () => {
    const a = freshUser("a");
    const sid = await openSession(a);
    const r = await whoami(a, sid);
    expect(r.status).toBe(200);
    expect(r.userId).toBe(a);
  });

  it("user B presenting A's session id gets 404 Session not found on POST, GET and DELETE; A is untouched", async () => {
    const a = freshUser("a");
    const b = freshUser("b");
    const sid = await openSession(a);

    const stolen = await whoami(b, sid);
    expect(stolen.status).toBe(404);
    expect(stolen.text).toContain("Session not found");
    expect(stolen.userId).toBeUndefined();

    const get = await mcp.fetch(
      new Request(`${ORIGIN}/mcp`, {
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sid,
          "mcp-protocol-version": PROTOCOL,
        },
      }),
      env as never,
      ctxFor(b)
    );
    expect(get.status).toBe(404);

    const del = await mcp.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sid, "mcp-protocol-version": PROTOCOL },
      }),
      env as never,
      ctxFor(b)
    );
    expect(del.status).toBe(404);

    // A's session survived B's DELETE and still answers as A.
    const mine = await whoami(a, sid);
    expect(mine.status).toBe(200);
    expect(mine.userId).toBe(a);
  });

  it("cold object: B hitting A's evicted session cannot overwrite A's stored props", async () => {
    const a = freshUser("a");
    const b = freshUser("b");
    const sid = await openSession(a);
    const name = `streamable-http:${sid}`;
    const stubA = env.MCP_OBJECT.get(
      env.MCP_OBJECT.idFromName(ownerBoundName(name, await sessionOwnerTag(a)))
    );
    await evictDurableObject(stubA, { webSockets: "close" });

    const stolen = await whoami(b, sid);
    expect(stolen.status).toBe(404);

    expect(await storedProps(name, a)).toEqual({ userId: a });
    const mine = await whoami(a, sid);
    expect(mine.status).toBe(200);
    expect(mine.userId).toBe(a);
  });

  it("no authenticated user → 401, the library is never reached", async () => {
    const res = await mcp.fetch(
      new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }),
      env as never,
      ctxFor(undefined)
    );
    expect(res.status).toBe(401);
  });
});

describe("OPE-1391 — legacy SSE transport (client-chosen ?sessionId)", () => {
  async function connect(userId: string, sessionId?: string): Promise<string> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await sse.fetch(
      new Request(`${ORIGIN}/sse${q}`, { headers: { Accept: "text/event-stream" } }),
      env as never,
      ctxFor(userId)
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const first = new TextDecoder().decode(value);
    const m = first.match(/sessionId=([^\s&]+)/);
    expect(m).toBeTruthy();
    return decodeURIComponent(m![1]);
  }

  it("B connecting with A's sessionId (A evicted) does not take over A's object", async () => {
    const a = freshUser("a");
    const b = freshUser("b");
    const sid = await connect(a);
    const name = `sse:${sid}`;
    expect(await storedProps(name, a)).toEqual({ userId: a });
    const stubA = env.MCP_OBJECT.get(
      env.MCP_OBJECT.idFromName(ownerBoundName(name, await sessionOwnerTag(a)))
    );
    await evictDurableObject(stubA, { webSockets: "close" });

    expect(await connect(b, sid)).toBe(sid);

    expect(await storedProps(name, a)).toEqual({ userId: a });
    expect(await storedProps(name, b)).toEqual({ userId: b });
  });
});
