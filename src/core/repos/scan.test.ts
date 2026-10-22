import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidates, inferProtocol, scanRoot, type Found } from "./scan";

const tempRoot = (name: string) => mkdtempSync(join(tmpdir(), `ddd-scan-${name}-`));

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function makeRepo(root: string, name: string, remote: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

function makeCheckoutWithoutRemote(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  return dir;
}

const at = (found: Found[], name: string) => found.find((f) => basename(f.path) === name);

describe("scanRoot", () => {
  it("finds repos one level down and skips everything else", async () => {
    const root = tempRoot("basic");
    makeRepo(root, "ddd", "git@github.com:agitri/ddd.git");
    makeRepo(root, "renter", "https://github.com/agitri/renter.git");
    mkdirSync(join(root, "just-a-folder"));
    writeFileSync(join(root, "a-file.txt"), "x");

    const found = await scanRoot(root);
    expect(found).toHaveLength(2);
    expect(at(found, "ddd")!.url).toContain("agitri/ddd");
    // Stable order so a rescan produces a diffable result.
    expect(found.map((f) => basename(f.path))).toEqual(["ddd", "renter"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a checkout that has no origin", async () => {
    // Discarding these is how two thirds of a real projects folder became
    // invisible: a scratch repo is still a repository.
    const root = tempRoot("no-origin");
    makeRepo(root, "ddd", "git@github.com:agitri/ddd.git");
    makeCheckoutWithoutRemote(root, "scratch");

    const found = await scanRoot(root);
    expect(found).toHaveLength(2);
    expect(at(found, "scratch")!.url).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a worktree whose .git is a file", async () => {
    // `git worktree` and submodules write `.git` as a *file* holding a gitdir:
    // pointer. The filter deliberately tests only for existence, so these are
    // found — a future `.isDirectory()` "tidy-up" would silently drop every
    // worktree on the machine.
    const root = tempRoot("worktree");
    const dir = join(root, "linked");
    mkdirSync(dir);
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");

    const found = await scanRoot(root);
    expect(found).toHaveLength(1);
    expect(basename(found[0]!.path)).toBe("linked");
    // git cannot resolve a remote through a dangling gitdir pointer, so it
    // arrives remote-less — exactly the case the store now keeps.
    expect(found[0]!.url).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("follows a symlinked checkout", async () => {
    // A projects folder full of symlinks into an external drive is a normal
    // layout. The path stored is the link; canonicalization at the call site
    // resolves it.
    const root = tempRoot("symlink");
    const real = makeRepo(root, "real", "git@github.com:agitri/real.git");
    symlinkSync(real, join(root, "via-link"));

    const found = await scanRoot(root);
    expect(found.map((f) => basename(f.path)).sort()).toEqual(["real", "via-link"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("yields nothing for a root that is missing or is a file, rather than erroring", async () => {
    // A scan root the user deleted, or picked wrongly, is an empty result —
    // `repo_scan` checks isDir and reports, so this layer stays total.
    const root = tempRoot("bad-root");
    expect(await scanRoot(join(root, "does-not-exist"))).toEqual([]);
    const file = join(root, "a-file.txt");
    writeFileSync(file, "x");
    expect(await scanRoot(file)).toEqual([]);
    expect(candidates(file)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("inferProtocol", () => {
  const found = (...urls: (string | null)[]): Found[] => urls.map((url, i) => ({ path: `/p${i}`, url }));

  it("infers the protocol the user actually uses", () => {
    expect(inferProtocol(found("git@github.com:a/b.git", "git@github.com:c/d.git", "https://github.com/e/f.git", null))).toBe("ssh");
    expect(inferProtocol([])).toBeNull();
  });

  it("infers nothing from a root of remote-less checkouts", () => {
    // The same answer as an empty root, and for the same reason: nothing to
    // infer from.
    expect(inferProtocol(found(null, null))).toBeNull();
  });

  it("breaks ties towards ssh", () => {
    // Exactly half SSH is the boundary `ssh * 2 >= len` decides. An HTTPS clone
    // of a private repo fails confusingly without a credential helper, where
    // SSH at least fails at a key the user recognises.
    expect(inferProtocol(found("git@github.com:a/b.git", "https://github.com/c/d.git"))).toBe("ssh");
    expect(inferProtocol(found("git@github.com:a/b.git", "https://github.com/c/d.git", "https://github.com/e/f.git"))).toBe("https");
  });

  it("counts ssh urls in both spellings", () => {
    expect(inferProtocol(found("ssh://git@github.com/a/b.git", "git@github.com:c/d.git"))).toBe("ssh");
  });
});
