import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { check, checksFromJson, classify, isFresh, isServing, refresh, short, type Checks } from "./live";

/** A fetch that never reaches a network. Records what was asked of it. */
function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url: String(url), method: init?.method ?? "GET", headers });
    return reply(String(url), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function timeoutError(): Error {
  // What `AbortSignal.timeout(ms)` aborts with, and what `check` looks for.
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

describe("is the thing at that URL still answering", () => {
  it("a timeout is never reported as gone", () => {
    // Someone else's server being slow, or a CDN that dislikes HEAD, is not
    // evidence that the site is down.
    expect(classify(null, true, null)).toEqual({ state: "noAnswer", detail: "no reply within the deadline" });
    expect(classify(null, true, null).state).not.toBe("unreachable");
  });

  it("any status code at all counts as answering", () => {
    // A 403 from a server means a server is there, which is the entire question
    // being asked.
    for (const code of [200, 301, 403, 500]) {
      expect(isServing(classify(code, false, null))).toBe(true);
    }
  });

  it("a refused connection is the one that means gone", () => {
    const v = classify(null, false, "connection refused");
    expect(v).toEqual({ state: "unreachable", detail: "connection refused" });
    expect(isServing(v)).toBe(false);
    expect(classify(null, false, null)).toEqual({ state: "unreachable", detail: "could not connect" });
  });

  it("a url that was never valid is never requested", async () => {
    // Belt and braces: the watchlist refuses these on entry, and this is the
    // last point before an outbound request.
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 200 }));
    for (const bad of ["file:///etc/passwd", "localhost:3000", "javascript:alert(1)"]) {
      expect(await check(fetch, bad)).toEqual({ state: "unreachable", detail: "not an http address" });
    }
    expect(calls).toEqual([]);
  });

  it("check sends a HEAD with the named user agent, and reads a 200 and a 404 alike", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/missing") ? new Response("", { status: 404, statusText: "Not Found" }) : new Response("", { status: 200 }),
    );
    expect(await check(fetch, "https://serving.example")).toEqual({ state: "answering", detail: 200 });
    expect(await check(fetch, "https://serving.example/missing")).toEqual({ state: "answering", detail: 404 });
    expect(calls[0]!.method).toBe("HEAD");
    expect(calls[0]!.headers["user-agent"]).toBe("DDD-dashboard (support watch)");
  });

  it("a thrown timeout is noAnswer and a network error is unreachable", async () => {
    const slow = fakeFetch(() => {
      throw timeoutError();
    });
    expect(await check(slow.fetch, "https://slow.example")).toEqual({
      state: "noAnswer",
      detail: "no reply within the deadline",
    });

    const dead = fakeFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1");
    });
    expect(await check(dead.fetch, "https://gone.example")).toEqual({ state: "unreachable", detail: "fetch failed" });
  });

  it("short keeps a reason, not a stack", () => {
    // The naive `split(':')[0]` the Rust does: no reqwest-style special case,
    // so a Node-shaped connection error is cut at its own first colon.
    expect(short(new Error("fetch failed: ECONNREFUSED 127.0.0.1:1"))).toBe("fetch failed");
    expect(short("plain")).toBe("plain");
    // A reqwest-shaped message is not special-cased any more: it truncates at
    // its own first colon, same as anything else.
    expect(short(new Error("error sending request for url (https://x): connection refused"))).toBe("error sending request for url (https");
  });

  it("a real socket answers and a dead port does not", async () => {
    // A listener this test owns, so no external host is involved. (The Rust
    // test stops at `classify` because it believed `127.0.0.1` would fail
    // `validate_url`; it does not — the host has dots — so the port can do the
    // whole round trip here.)
    const server: Server = createServer((_req, res) => res.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    expect(await check(globalThis.fetch, url)).toEqual({ state: "answering", detail: 200 });
    await new Promise<void>((done) => server.close(() => done()));
    expect((await check(globalThis.fetch, url)).state).toBe("unreachable");
  });

  it("a fresh check is not repeated", async () => {
    const checked = { at: "2026-09-04T09:30:00Z", liveness: { state: "answering", detail: 200 } } as const;
    expect(isFresh(checked, "2026-09-04T10:00:00Z")).toBe(true); // half an hour old
    expect(isFresh(checked, "2026-09-04T11:00:00Z")).toBe(false); // an hour is the boundary
    expect(isFresh(checked, "2026-09-03T09:00:00Z")).toBe(false); // a clock that went backwards
    expect(isFresh({ at: "not a date", liveness: { state: "answering", detail: 200 } }, "2026-09-04T10:00:00Z")).toBe(false);

    const checks: Checks = { "https://a.example": { ...checked } };
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 500 }));
    await refresh(fetch, checks, ["https://a.example", "https://b.example"], "2026-09-04T10:00:00Z");
    expect(calls.map((c) => c.url)).toEqual(["https://b.example"]);
    expect(checks["https://a.example"]!.liveness).toEqual({ state: "answering", detail: 200 });
    expect(checks["https://b.example"]).toEqual({
      at: "2026-09-04T10:00:00Z",
      liveness: { state: "answering", detail: 500 },
    });
  });

  it("reads the stored shape back", () => {
    expect(checksFromJson({ "https://a.example": { at: "t", liveness: { state: "noAnswer", detail: "slow" } } })).toEqual({
      "https://a.example": { at: "t", liveness: { state: "noAnswer", detail: "slow" } },
    });
    expect(() => checksFromJson({ x: { at: "t", liveness: { state: "sideways", detail: "x" } } })).toThrow(/^json: /);
    expect(() => checksFromJson({ x: { at: "t", liveness: { state: "answering", detail: "200" } } })).toThrow(/^json: /);
  });
});
