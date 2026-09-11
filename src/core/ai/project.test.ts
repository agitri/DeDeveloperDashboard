import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Item } from "../models";
import { register } from "../projects";
import { upsert } from "../repos/links";
import { scratchEnv } from "../testing";
import { projectDirFor, resolveProjectDir } from "./project";

/** A fresh, real directory whose basename is exactly `name`; uniqueness lives
 *  in the parent so it never pollutes the basename under test. */
function tempDir(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), "ddd-project-dir-for-"));
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function item(project: string | null): Item {
  return { id: "i", environmentId: "default", connectionId: "c", source: "github", kind: "issue", project, title: "t", body: null, url: null, refs: [], actions: [], updatedAt: "now", unread: false };
}

describe("resolveProjectDir", () => {
  it("a stored link wins over a same-named project in another org", () => {
    const { env } = scratchEnv("link-beats-name");
    // The name-only matcher would find this one: its directory name is `api`,
    // the tail of both `orga/api` and `orgb/api`. It must NOT win once a real
    // remote is known.
    const wrong = tempDir("api");
    register(env, wrong);
    const right = tempDir("api-actual");
    upsert(env, { remote: "github.com/orga/api", path: right, source: "manual", confidence: "exact" });

    expect(resolveProjectDir(env, "orga/api")).toBe(right);
    // The other org has no link, so it falls through to the name match.
    expect(resolveProjectDir(env, "orgb/api")).toBe(wrong);
  });

  it("a link whose folder is gone does not answer; names are matched case-insensitively on the tail", () => {
    const { env } = scratchEnv("link-missing");
    upsert(env, { remote: "github.com/orga/api", path: "/nowhere/api", source: "manual", confidence: "exact" });
    expect(resolveProjectDir(env, "orga/api")).toBeNull();

    const dir = tempDir("MyProj");
    register(env, dir);
    expect(resolveProjectDir(env, "someone/myproj")).toBe(dir);
    expect(resolveProjectDir(env, "myproj")).toBe(dir);
    expect(resolveProjectDir(env, "other")).toBeNull();
  });

  it("projectDirFor lowercases the item's project and answers null without one", () => {
    const { env } = scratchEnv("project-dir-for");
    const dir = tempDir("ddd");
    register(env, dir);
    expect(projectDirFor(env, item("Agitri/DDD"))).toBe(dir);
    expect(projectDirFor(env, item(null))).toBeNull();
  });
});
