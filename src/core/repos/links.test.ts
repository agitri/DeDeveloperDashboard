import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchEnv } from "../testing";
import { load, repoLinksFromJson, save, upsert } from "./links";

describe("repo links", () => {
  it("an absent file is an empty store", () => {
    const { env } = scratchEnv("links-absent");
    expect(load(env)).toEqual({ links: [], scanRoots: [], preferredProtocol: null });
  });

  it("upsert holds one record per path and one per remote, newest claim winning", () => {
    const { env } = scratchEnv("links-upsert");
    upsert(env, { remote: "github.com/a/x", path: "/p/x", source: "scan", confidence: "exact" });
    upsert(env, { remote: "github.com/a/x", path: "/p/x2", source: "manual", confidence: "exact" });
    upsert(env, { remote: null, path: "/p/local1", source: "manual", confidence: "fallback" });
    upsert(env, { remote: null, path: "/p/local2", source: "manual", confidence: "fallback" });
    const stored = load(env);
    expect(stored.links.map((l) => l.path)).toEqual(["/p/x2", "/p/local1", "/p/local2"]);
    // Same path again replaces in place (well, at the end — the Rust pushes).
    upsert(env, { remote: "github.com/a/y", path: "/p/local1", source: "manual", confidence: "exact" });
    expect(load(env).links.map((l) => [l.path, l.remote])).toEqual([["/p/x2", "github.com/a/x"], ["/p/local2", null], ["/p/local1", "github.com/a/y"]]);
  });

  it("writes the Rust's field order and reads an old file whose records all have a remote", () => {
    const { env } = scratchEnv("links-shape");
    save(env, { links: [{ remote: "github.com/a/x", path: "/p/x", source: "scan", confidence: "exact" }], scanRoots: ["/p"], preferredProtocol: "ssh" });
    const text = readFileSync(env.repoLinksFile(), "utf8");
    expect(text).toBe(
      '{\n  "links": [\n    {\n      "remote": "github.com/a/x",\n      "path": "/p/x",\n      "source": "scan",\n      "confidence": "exact"\n    }\n  ],\n  "scanRoots": [\n    "/p"\n  ],\n  "preferredProtocol": "ssh"\n}',
    );
    expect(repoLinksFromJson({ links: [{ remote: "r", path: "/q", source: "manual", confidence: "fallback" }] })).toEqual({
      links: [{ remote: "r", path: "/q", source: "manual", confidence: "fallback" }],
      scanRoots: [],
      preferredProtocol: null,
    });
  });

  it("refuses a malformed record", () => {
    expect(() => repoLinksFromJson({ links: [{ path: "/q", source: "scan" }] })).toThrow(/^json: /);
    expect(() => repoLinksFromJson({ links: [{ path: "/q", source: "carrier-pigeon", confidence: "exact" }] })).toThrow(/^json: /);
  });
});
