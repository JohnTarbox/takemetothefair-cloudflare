/**
 * OPE-1031 — a service-binding Request to the main app must carry its Host.
 *
 * Production specimen (error_logs, source 'upload-image-slot', 21 rows, latest
 * 2026-09-13 00:25:33Z):
 *   requestUrl: "https://undefined/api/admin/upload-image-slot"
 *
 * The chain, each link read from source:
 *   1. `new Request(url)` has no `host` header — a public fetch adds one on the
 *      wire; a service binding passes the object across untouched.
 *   2. OpenNext's edge converter (bundled into .open-next/.../handler.mjs)
 *      re-issues it as `{ ...headers, "x-forwarded-host": headers.host }`.
 *   3. `new Headers({ "x-forwarded-host": undefined })` stores the STRING
 *      "undefined"; the request handler then copies x-forwarded-host → host.
 *
 * `replayOpenNextHost` below is links 2–3, so the defect and the fix are both
 * asserted against the same conversion rather than against our own helper.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mainAppBindingRequest, mainAppFetch, realHostOf } from "../src/main-app-fetch.js";

const BASE = "https://meetmeatthefair.com";

/** OpenNext's host derivation for an incoming Request (links 2–3 above). */
function replayOpenNextHost(req: Request): string | null {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const forwarded = new Headers({
    ...headers,
    "x-forwarded-host": headers.host as unknown as string,
  });
  return forwarded.get("x-forwarded-host");
}

describe("the defect, reproduced", () => {
  it("a bare new Request reaches OpenNext with host 'undefined'", () => {
    const bare = new Request(`${BASE}/api/admin/upload-image-slot`, { method: "POST" });
    expect(bare.headers.get("host")).toBeNull();
    expect(replayOpenNextHost(bare)).toBe("undefined");
  });
});

describe("mainAppBindingRequest", () => {
  it("carries the URL's host, so OpenNext reconstructs the real origin", () => {
    const req = mainAppBindingRequest(`${BASE}/api/admin/upload-image-slot`, { method: "POST" });
    expect(req.headers.get("host")).toBe("meetmeatthefair.com");
    expect(replayOpenNextHost(req)).toBe("meetmeatthefair.com");
  });

  it("keeps a port in the host (local dev) and an explicit host the caller set", () => {
    expect(mainAppBindingRequest("http://localhost:3000/x").headers.get("host")).toBe(
      "localhost:3000"
    );
    const explicit = mainAppBindingRequest(`${BASE}/x`, { headers: { Host: "preview.example" } });
    expect(explicit.headers.get("host")).toBe("preview.example");
  });

  it("preserves method, body and every other header", async () => {
    const req = mainAppBindingRequest(`${BASE}/x`, {
      method: "POST",
      headers: { "X-Internal-Key": "k", "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(req.method).toBe("POST");
    expect(req.headers.get("x-internal-key")).toBe("k");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.json()).toEqual({ a: 1 });
  });

  it.each([
    ["an unset MAIN_APP_URL", "undefined/api/admin/upload-image-slot"],
    ["the literal specimen", "https://undefined/api/admin/upload-image-slot"],
    ["a stringified null", "https://null/x"],
    ["an empty base", "/api/admin/upload-image-slot"],
  ])("throws loudly on %s instead of minting a hostless request", (_label, url) => {
    expect(() => mainAppBindingRequest(url)).toThrow(/no usable host/);
  });

  it("realHostOf rejects nullish, stringified-nullish and unparseable input", () => {
    for (const bad of [undefined, null, "", "not a url", "https://undefined", "https://null"]) {
      expect(realHostOf(bad)).toBeNull();
    }
    expect(realHostOf(`${BASE}/a`)).toBe("meetmeatthefair.com");
  });
});

describe("mainAppFetch", () => {
  it("hands the binding a Request with the host set", async () => {
    let seen: Request | null = null;
    const env = {
      MAIN_APP_URL: BASE,
      INTERNAL_API_KEY: "k",
      MAIN_APP: {
        fetch: async (r: Request) => {
          seen = r;
          return new Response("ok");
        },
      },
    };
    await mainAppFetch(env, "/api/admin/upload-image-slot", "fetch", { method: "POST" });
    expect(seen).not.toBeNull();
    expect(replayOpenNextHost(seen as unknown as Request)).toBe("meetmeatthefair.com");
  });

  it("a hostless MAIN_APP_URL fails the call — it does NOT fall through to the public path", async () => {
    let bindingCalls = 0;
    const env = {
      MAIN_APP_URL: "https://undefined",
      INTERNAL_API_KEY: "k",
      MAIN_APP: {
        fetch: async () => {
          bindingCalls++;
          return new Response("ok");
        },
      },
    };
    await expect(mainAppFetch(env, "/x", "fetch")).rejects.toThrow(/no usable host/);
    expect(bindingCalls).toBe(0);
  });
});

describe("structural guard — every MAIN_APP binding call builds its Request through the helper", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(SRC);

  it("finds the binding calls at all (a zero here means the guard is inert, not passing)", () => {
    const total = files
      .map((f) => (readFileSync(f, "utf8").match(/MAIN_APP\??\.fetch\(/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(18);
  });

  it("no binding call passes a Request built any other way", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const re = /MAIN_APP\??\.fetch\(\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const arg = m[1];
        const ok =
          arg === "mainAppBindingRequest" ||
          // main-app-fetch.ts builds it one line earlier, outside its try.
          (f.endsWith("main-app-fetch.ts") && arg === "bindingRequest");
        if (!ok) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${f.slice(SRC.length + 1)}:${line} → ${arg}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("deployed config", () => {
  it("mcp-server/wrangler.toml names a MAIN_APP_URL with a real host alongside the MAIN_APP binding", () => {
    const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
    expect(toml).toMatch(/binding\s*=\s*"MAIN_APP"/);
    const m = toml.match(/^MAIN_APP_URL\s*=\s*"([^"]*)"/m);
    expect(m, "MAIN_APP_URL missing from [vars]").not.toBeNull();
    expect(realHostOf(m![1])).toBe("meetmeatthefair.com");
  });
});
