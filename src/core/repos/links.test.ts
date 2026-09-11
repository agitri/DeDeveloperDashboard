import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchEnv } from "../testing";
import { canonicalPath, find, findWithTier, load, remove, removeByPath, repoLinksFromJson, save, upsert, type RepoLinks } from "./links";

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

describe("finding and removing links", () => {
  it("round-trips, replaces the same remote at a new path, and removes by remote", () => {
    const { env } = scratchEnv("roundtrip");
    expect(load(env).links).toEqual([]);

    upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd", source: "scan", confidence: "exact" });
    // A repo cannot be in two places; the newest claim wins.
    upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd-moved", source: "manual", confidence: "exact" });

    const stored = load(env);
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.path).toBe("/tmp/ddd-moved");
    expect(stored.links[0]!.source).toBe("manual");

    expect(find(stored, "github.com/agitri/ddd")).not.toBeNull();
    expect(find(stored, "github.com/agitri/other")).toBeNull();

    remove(env, "github.com/agitri/ddd");
    expect(load(env).links).toEqual([]);
  });

  it("never returns a checkout that has no remote", () => {
    const { env } = scratchEnv("find-skips-none");
    upsert(env, { remote: null, path: "/tmp/a", source: "scan", confidence: "exact" });
    expect(find(load(env), "github.com/agitri/ddd")).toBeNull();
  });

  it("removeByPath drops only that checkout", () => {
    const { env } = scratchEnv("remove-by-path");
    upsert(env, { remote: null, path: "/tmp/a", source: "scan", confidence: "exact" });
    upsert(env, { remote: null, path: "/tmp/b", source: "scan", confidence: "exact" });

    removeByPath(env, "/tmp/a");
    const stored = load(env);
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.path).toBe("/tmp/b");
  });

  it("removing an absent remote leaves other links untouched", () => {
    const { env } = scratchEnv("remove-absent");
    upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd", source: "scan", confidence: "exact" });
    remove(env, "github.com/agitri/never-stored");

    const stored = load(env);
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.remote).toBe("github.com/agitri/ddd");
  });
});

describe("findWithTier reports the tier this lookup used", () => {
  const store = (link: { remote: string; path: string; confidence: "exact" | "fallback" }): RepoLinks => ({
    links: [{ remote: link.remote, path: link.path, source: "scan", confidence: link.confidence }],
    scanRoots: [],
    preferredProtocol: null,
  });

  it("reports exact even when the stored link itself is fallback", () => {
    // The stored link's own confidence is fallback, but this lookup found it
    // via the exact `remote:` key — the join's own tier wins.
    const stored = store({ remote: "github.com/agitri/ddd", path: "/repo", confidence: "fallback" });
    const matched = findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd");
    expect(matched).not.toBeNull();
    expect(matched!.link.path).toBe("/repo");
    expect(matched!.confidence).toBe("exact");
  });

  it("reports fallback even when the stored link itself is exact", () => {
    // The regression case: the exact `remote:` key does not match (a different
    // host), but owner/repo does. The stored link says exact — because *it* was
    // established with full confidence — but *this* lookup only found it
    // through the weak tier, so the row must say so.
    const stored = store({ remote: "gitlab.com/agitri/ddd", path: "/repo", confidence: "exact" });
    const matched = findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd");
    expect(matched).not.toBeNull();
    expect(matched!.link.path).toBe("/repo");
    expect(matched!.confidence).toBe("fallback");
  });

  it("returns null when neither key matches", () => {
    const stored = store({ remote: "gitlab.com/other/thing", path: "/elsewhere", confidence: "exact" });
    expect(findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd")).toBeNull();
  });

  it("cannot produce a false positive from an empty key", () => {
    // A repo whose URL failed to normalize has no `remote:` ref, so the caller
    // passes an empty string. With no `https:` ref either there is nothing to
    // key a fallback off — an empty query key must not act as a wildcard.
    const stored = store({ remote: "github.com/agitri/ddd", path: "/repo", confidence: "exact" });
    expect(findWithTier(stored, "", "")).toBeNull();
  });

  it("skips a checkout with no remote at the fallback tier too", () => {
    const stored: RepoLinks = { links: [{ remote: null, path: "/repo", source: "scan", confidence: "exact" }], scanRoots: [], preferredProtocol: null };
    expect(findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd")).toBeNull();
  });
});

describe("canonicalPath", () => {
  it("resolves a real path and throws io for one that is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-canon-"));
    // Not compared against `dir` itself: a macOS temp dir lives behind a
    // symlink (/var → /private/var), which is exactly what this has to resolve.
    expect(canonicalPath(dir)).toBe(realpathSync(dir));
    // Every spelling of the same folder collapses to one string — the whole
    // reason the link store goes through this.
    expect(canonicalPath(join(dir, "."))).toBe(canonicalPath(dir));
    expect(canonicalPath(`${dir}/`)).toBe(canonicalPath(dir));
    // A path that vanished between being found and being stored is a real
    // error, not something to paper over by falling back to the raw path.
    expect(() => canonicalPath(join(dir, "does-not-exist"))).toThrow(/^io: /);
    rmSync(dir, { recursive: true, force: true });
  });
});
