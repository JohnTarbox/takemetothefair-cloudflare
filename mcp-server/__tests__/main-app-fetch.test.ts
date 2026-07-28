/**
 * OPE-258 — the shared MCP→main-app caller.
 *
 * The two behaviours worth pinning are the ones that made the original bug
 * hard to diagnose and hard to fix safely: the entrypoint stamp (so a future
 * 401 names its own caller instead of costing three investigation cycles) and
 * the binding→public fallback (so enabling the service binding cannot be worse
 * than the previous no-fallback ternary).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mainAppFetch } from "../src/main-app-fetch.js";

const KEY = "k".repeat(64);
const baseEnv = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: KEY };

let globalFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("mainAppFetch transport selection", () => {
  it("prefers the service binding when bound — the whole point of the fix", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) };
    await mainAppFetch({ ...baseEnv, MAIN_APP: binding }, "/api/admin/x", "fetch");
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("falls back to public fetch when the binding throws — strictly safer than before", async () => {
    const binding = { fetch: vi.fn().mockRejectedValue(new Error("binding blip")) };
    const res = await mainAppFetch({ ...baseEnv, MAIN_APP: binding }, "/api/admin/x", "scheduled");
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("uses public fetch when no binding is configured (local dev)", async () => {
    await mainAppFetch(baseEnv, "/api/admin/x", "fetch");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch.mock.calls[0][0]).toBe("https://meetmeatthefair.com/api/admin/x");
  });

  it("throws only when NEITHER transport can work — a deploy error worth surfacing", async () => {
    await expect(
      mainAppFetch({ MAIN_APP_URL: "https://meetmeatthefair.com" }, "/api/admin/x", "fetch")
    ).rejects.toThrow(/INTERNAL_API_KEY/);
  });
});

describe("mainAppFetch headers", () => {
  it("sends the internal key AND stamps the entrypoint on the public path", async () => {
    await mainAppFetch(baseEnv, "/api/admin/x", "queue", { method: "POST" });
    const init = globalFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Internal-Key"]).toBe(KEY);
    expect(headers["X-MMATF-Entrypoint"]).toBe("queue");
    expect(init.method).toBe("POST");
  });

  it("stamps the entrypoint on the BINDING path too — the dimension OPE-258 lacked", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(new Response("{}")) };
    await mainAppFetch({ ...baseEnv, MAIN_APP: binding }, "/api/admin/x", "durable-object");
    const req = binding.fetch.mock.calls[0][0] as Request;
    expect(req.headers.get("x-mmatf-entrypoint")).toBe("durable-object");
    expect(req.headers.get("x-internal-key")).toBe(KEY);
  });

  it("preserves caller headers without letting them clobber auth", async () => {
    await mainAppFetch(baseEnv, "/api/admin/x", "fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": "attacker-supplied" },
    });
    const headers = (globalFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    // The real key wins — caller headers are spread FIRST, auth applied after.
    expect(headers["X-Internal-Key"]).toBe(KEY);
  });
});
