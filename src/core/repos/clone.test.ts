import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "../projects";
import { scratchEnv } from "../testing";
import { parseProgress, prepare, run, targetDir, type Progress } from "./clone";
import { canonicalPath, find, load } from "./links";

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `ddd-clone-${name}-`));

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

/**
 * A bare repository with one commit in it, to clone from. Cloning from a
 * `file://` URL is a real clone over git's transport layer: git forks
 * git-upload-pack and emits the same carriage-return progress stream a network
 * clone does. The scheme is what forces it — handed a bare path, git shortcuts
 * a same-filesystem clone to a hardlink copy and prints no progress at all,
 * which would leave the stderr parsing (the most fragile part of this module)
 * untested while still passing.
 */
function originRepo(root: string): string {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q"]);
  git(seed, ["config", "user.email", "test@example.dev"]);
  git(seed, ["config", "user.name", "Test"]);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "first"]);
  const bare = join(root, "origin.git");
  execFileSync("git", ["clone", "--bare", "-q", seed, bare], { stdio: "ignore" });
  return bare;
}

describe("parseProgress", () => {
  it("reads percentages out of git progress lines", () => {
    expect(parseProgress("Receiving objects:  41% (4100/10000), 1.2 MiB")).toEqual({ phase: "Receiving objects", percent: 41 });
    expect(parseProgress("Resolving deltas: 100% (500/500), done.")).toEqual({ phase: "Resolving deltas", percent: 100 });
  });

  it("ignores lines that are not progress", () => {
    expect(parseProgress("Cloning into 'ddd'...")).toBeNull();
    expect(parseProgress("")).toBeNull();
  });

  it("clamps over 100 and rejects unparseable numbers", () => {
    // git never actually emits these, but a hostile or truncated line must not
    // panic — clamp what parses, reject what does not.
    expect(parseProgress("Counting objects: 150% (150/100), done.")).toEqual({ phase: "Counting objects", percent: 100 });
    expect(parseProgress("Counting objects: abc% (0/0)")).toBeNull();
    // The Rust parses into a u8 before clamping, so anything over 255 is not a
    // number it accepts at all.
    expect(parseProgress("Counting objects: 300% (1/1)")).toBeNull();
  });
});

describe("prepare and targetDir", () => {
  it("puts the clone at the repo name under the parent, ignoring a trailing slash", () => {
    expect(targetDir("/tmp", "github.com/agitri/ddd")).toBe(join("/tmp", "ddd"));
    expect(targetDir("/tmp", "github.com/agitri/ddd/")).toBe(join("/tmp", "ddd"));
  });

  it("refuses a missing parent and a non-empty target, but allows an empty one", () => {
    const root = scratch("prepare");
    expect(() => prepare(join(root, "nowhere"), "github.com/a/b")).toThrow(`${join(root, "nowhere")} is not a directory`);

    const occupied = join(root, "b");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "something"), "x");
    expect(() => prepare(root, "github.com/a/b")).toThrow(`${occupied} already exists and is not empty`);

    // An *empty* directory is fine — that is a picker artefact, not a repo.
    mkdirSync(join(root, "c"));
    expect(prepare(root, "github.com/a/c")).toBe(join(root, "c"));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("run", () => {
  it("clones for real, and links and registers the result", async () => {
    const home = scratchEnv("clone-e2e");
    const root = scratch("e2e");
    const origin = originRepo(root);
    const parent = join(root, "into");
    mkdirSync(parent, { recursive: true });

    const remote = "github.com/agitri/origin";
    const target = prepare(parent, remote);
    const ticks: Progress[] = [];
    await run(home.env, remote, `file://${origin}`, target, (p) => ticks.push(p));

    const last = ticks[ticks.length - 1]!;
    expect(last).toEqual({ phase: "Done", percent: 100, done: true, error: null });
    expect(ticks[0]).toEqual({ phase: "Starting", percent: 0, done: false, error: null });

    // The point of the exercise: git's carriage-return progress stream was
    // parsed, not merely survived. If this ever fails because the fixture is
    // too small for git to bother reporting, the parser is untested again and
    // the fixture needs to grow — not this assertion.
    expect(ticks.some((t) => t.phase !== "Starting" && t.phase !== "Done")).toBe(true);

    // The checkout is really there.
    expect(existsSync(join(target, "README.md"))).toBe(true);

    // …and the link store and project registry both know about it, at the
    // canonical path the projectId join depends on.
    const link = find(load(home.env), remote);
    expect(link).not.toBeNull();
    expect(link!.path).toBe(canonicalPath(target));
    expect(link!.source).toBe("manual");
    expect(link!.confidence).toBe("exact");
    expect(registry(home.env).projects.some((p) => p.path === link!.path)).toBe(true);

    rmSync(root, { recursive: true, force: true });
  }, 30000);

  it("reports git's own words when the clone fails, and stores nothing", async () => {
    const home = scratchEnv("clone-fails");
    const root = scratch("fail");
    const parent = join(root, "into");
    mkdirSync(parent, { recursive: true });

    const remote = "github.com/agitri/nope";
    const target = prepare(parent, remote);
    const ticks: Progress[] = [];
    await run(home.env, remote, `file://${join(root, "does-not-exist")}`, target, (p) => ticks.push(p));

    const last = ticks[ticks.length - 1]!;
    expect(last.done).toBe(true);
    expect(last.phase).toBe("Failed");
    expect(last.percent).toBe(0);
    // git's own tail, not a message of ours.
    expect(last.error).toContain("does not appear to be a git repository");

    // Nothing half-linked: a failed clone leaves the store as it found it.
    expect(load(home.env).links).toEqual([]);
    expect(registry(home.env).projects).toEqual([]);

    rmSync(root, { recursive: true, force: true });
  }, 30000);

  it("reports a git that will not start, through the injected spawn", async () => {
    const home = scratchEnv("clone-no-git");
    const never = join(tmpdir(), "ddd-clone-never-created");
    const ticks: Progress[] = [];
    await run(
      home.env,
      "github.com/a/b",
      "file:///nowhere",
      never,
      (p) => ticks.push(p),
      () => {
        throw new Error("spawn git ENOENT");
      },
    );
    expect(ticks[ticks.length - 1]).toEqual({ phase: "Failed", percent: 0, done: true, error: "could not start git: spawn git ENOENT" });
    expect(existsSync(never)).toBe(false);
    expect(load(home.env).links).toEqual([]);
  });

  it("returns before the first progress tick fires — the caller must be able to return its own result first", async () => {
    const home = scratchEnv("clone-defer");
    const never = join(tmpdir(), "ddd-clone-defer-target");
    const ticks: Progress[] = [];
    const promise = run(
      home.env,
      "github.com/a/b",
      "file:///nowhere",
      never,
      (p) => ticks.push(p),
      () => {
        throw new Error("spawn git ENOENT");
      },
    );
    // Nothing has fired yet, synchronously after the call — same tick as
    // `repo_clone` returning its target to the caller.
    expect(ticks.length).toBe(0);
    await promise;
    expect(ticks[0]).toEqual({ phase: "Starting", percent: 0, done: false, error: null });
  });
});
