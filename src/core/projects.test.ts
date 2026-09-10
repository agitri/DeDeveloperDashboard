import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { scratchEnv } from "./testing";
import {
  GIT_EXEC_OPTIONS,
  configOf,
  gitRemote,
  gitStatus,
  identity,
  load,
  loadAll,
  register,
  registry,
  shellexpandHome,
  slug,
  unregister,
} from "./projects";

const tempdir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `ddd-projects-${name}-`)));

describe("slug", () => {
  it("is the lowercased folder name plus a hash of the whole path", () => {
    // Two checkouts of the same repo name stay distinguishable.
    const a = slug("/Users/me/Projects/DDD");
    const b = slug("/Users/me/work/DDD");
    expect(a).toMatch(/^ddd-[0-9a-f]{1,6}$/);
    expect(b).toMatch(/^ddd-[0-9a-f]{1,6}$/);
    expect(a).not.toBe(b);
    expect(slug("/x/Rene's stuff")).toMatch(/^rene-s-stuff-/);
    // Stable: the id is what layout.json and events refer to.
    expect(slug("/Users/me/Projects/DDD")).toBe(a);
  });

  it("matches the Rust's djb2-xor for a known input", () => {
    // Computed with the Rust: fold(5381, |h, b| h.wrapping_mul(33) ^ b) & 0xffffff, hex.
    expect(slug("/tmp/p")).toBe("p-ce09bc");
  });

  it("dashes an astral-plane character as one scalar value, like Rust's chars()", () => {
    // A surrogate pair must not become two dashes.
    expect(slug("/tmp/😀").startsWith("--")).toBe(true);
    expect(slug("/tmp/😀").startsWith("---")).toBe(false);
  });
});

describe("GIT_EXEC_OPTIONS", () => {
  it("never truncates, never hangs, never prompts — a pin so nobody drops it", () => {
    expect(GIT_EXEC_OPTIONS.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(GIT_EXEC_OPTIONS.timeout).toBeGreaterThan(0);
    expect(GIT_EXEC_OPTIONS.env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("home expansion", () => {
  it("expands a leading ~/ and nothing else", () => {
    expect(shellexpandHome("~/Projects/x")).toBe(join(homedir(), "Projects/x"));
    expect(shellexpandHome("/abs/~/x")).toBe("/abs/~/x");
    expect(shellexpandHome("~")).toBe("~");
  });
});

describe("registry", () => {
  it("is empty for a fresh environment", () => {
    const { env } = scratchEnv("registry-empty");
    expect(registry(env)).toEqual({ projects: [] });
  });

  it("registers a directory by its canonical path, once", () => {
    const { env } = scratchEnv("registry-register");
    const dir = tempdir("proj");
    const link = join(tempdir("link"), "alias");
    symlinkSync(dir, link);

    const first = register(env, dir);
    expect(first).toEqual({ id: slug(dir), path: dir });
    // The same folder through a symlink is the same project.
    expect(register(env, link)).toEqual(first);
    expect(registry(env).projects).toHaveLength(1);
    expect(JSON.parse(readFileSync(env.projectsFile(), "utf8"))).toEqual({ projects: [first] });
  });

  it("refuses a path that is not a directory", () => {
    const { env } = scratchEnv("registry-refuse");
    const missing = join(tmpdir(), "ddd-definitely-not-here");
    expect(() => register(env, missing)).toThrow(`${missing} is not a directory`);
  });

  it("unregisters by id and leaves the rest", () => {
    const { env } = scratchEnv("registry-unregister");
    const a = register(env, tempdir("a"));
    const b = register(env, tempdir("b"));
    unregister(env, a.id);
    expect(registry(env).projects).toEqual([b]);
    // Unknown ids are a no-op, as in the Rust.
    unregister(env, "nope");
    expect(registry(env).projects).toEqual([b]);
  });

  it("tolerates a projects.json with only some fields", () => {
    const { env } = scratchEnv("registry-partial");
    mkdirSync(env.dir, { recursive: true });
    const dir = tempdir("partial");
    writeFileSync(env.projectsFile(), JSON.stringify({ projects: [{ id: "x", path: dir }] }));
    expect(registry(env).projects).toEqual([{ id: "x", path: dir }]);
  });
});

const GIT_AUTHOR_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function gitRepo(name: string): string {
  const dir = tempdir(name);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: GIT_AUTHOR_ENV });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "first commit");
  return dir;
}

describe("git status", () => {
  it("reads branch, dirt and last commit from a real repository", async () => {
    const dir = gitRepo("git");
    writeFileSync(join(dir, "dirty.txt"), "x");
    const s = await gitStatus(dir);
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe("main");
    expect(s.dirtyFiles).toBe(1);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.lastCommitSummary).toBe("first commit");
    expect(s.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await gitRemote(dir)).toBeNull();
  });

  it("is the default for a folder that is not a repository", async () => {
    expect(await gitStatus(tempdir("norepo"))).toEqual({
      isRepo: false, branch: null, dirtyFiles: 0, ahead: 0, behind: 0, lastCommitSummary: null, lastCommitAt: null,
    });
  });

  it("reports ahead and behind against a real upstream, pinning the column order", async () => {
    const upstream = gitRepo("upstream");
    const clone = join(tempdir("clone-parent"), "clone");
    execFileSync("git", ["clone", "-q", upstream, clone], { stdio: "pipe", env: GIT_AUTHOR_ENV });
    const gitIn = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: GIT_AUTHOR_ENV });

    // One commit lands upstream after the clone...
    writeFileSync(join(upstream, "upstream-only.txt"), "u\n");
    gitIn(upstream, "add", "upstream-only.txt");
    gitIn(upstream, "commit", "-q", "-m", "second upstream commit");
    // ...and the clone learns about it the ordinary way, by fetching.
    gitIn(clone, "fetch", "-q", "origin", "main");

    // One commit lands locally in the clone, never pushed.
    writeFileSync(join(clone, "local-only.txt"), "l\n");
    gitIn(clone, "add", "local-only.txt");
    gitIn(clone, "commit", "-q", "-m", "local commit");

    const s = await gitStatus(clone);
    // rev-list --left-right --count prints "<behind> <ahead>"; this pins
    // that the Rust's column order survives the port.
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(1);
  });
});

describe("a project card", () => {
  it("assembles config, recap, todos and ICM files from .ddd/", async () => {
    const dir = gitRepo("card");
    mkdirSync(join(dir, ".ddd", "icm"), { recursive: true });
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ name: "Card", repos: ["o/r"], terminal: "iTerm" }));
    writeFileSync(join(dir, ".ddd", "recap.md"), "# Previously\n");
    writeFileSync(join(dir, ".ddd", "todos.json"), JSON.stringify({ todos: [{ id: "t1", text: "fix it" }] }));
    writeFileSync(join(dir, ".ddd", "icm", "b.md"), "");
    writeFileSync(join(dir, ".ddd", "icm", "a.md"), "");
    writeFileSync(join(dir, ".ddd", "icm", ".hidden"), "");

    const p = await load("card-1", dir);
    expect(p.id).toBe("card-1");
    expect(p.path).toBe(dir);
    expect(p.name).toBe("Card");
    expect(p.exists).toBe(true);
    expect(p.config).toEqual({ name: "Card", repos: ["o/r"], deployments: [], terminal: "iTerm", products: [] });
    expect(p.git.isRepo).toBe(true);
    expect(p.recap).toBe("# Previously\n");
    expect(p.recapUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.todos).toEqual([{ id: "t1", text: "fix it", done: false, createdAt: null, source: null }]);
    expect(p.icmFiles).toEqual(["a.md", "b.md"]);
    // Field order is the Rust struct order.
    expect(Object.keys(p)).toEqual(["id", "path", "name", "exists", "config", "git", "recap", "recapUpdatedAt", "todos", "icmFiles"]);
  });

  it("falls back to the folder name and empty everything when .ddd/ is absent", async () => {
    const dir = tempdir("bare");
    const p = await load("bare-1", dir);
    expect(p.name).toBe(basename(dir));
    expect(p.config).toEqual({ name: null, repos: [], deployments: [], terminal: null, products: [] });
    expect(p.git.isRepo).toBe(false);
    expect(p.recap).toBeNull();
    expect(p.recapUpdatedAt).toBeNull();
    expect(p.todos).toEqual([]);
    expect(p.icmFiles).toEqual([]);
  });

  it("marks a project whose folder is gone, without running git", async () => {
    const gone = join(tmpdir(), "ddd-gone-" + Date.now());
    const p = await load("gone-1", gone);
    expect(p.exists).toBe(false);
    expect(p.name).toBe(basename(gone));
    expect(p.git.isRepo).toBe(false);
  });

  it("a malformed config.json is an error for the card, but not for identity()", async () => {
    const dir = tempdir("badcfg");
    mkdirSync(join(dir, ".ddd"));
    writeFileSync(join(dir, ".ddd", "config.json"), "{ not json");
    await expect(load("bad-1", dir)).rejects.toThrow(/^json: /);
    expect(identity("bad-1", dir)).toEqual({ name: basename(dir), repos: [] });
    expect(configOf(dir)).toEqual({ name: null, repos: [], deployments: [], terminal: null, products: [] });
  });

  it("a malformed todos.json is swallowed — the card just has no todos", async () => {
    const dir = tempdir("badtodos");
    mkdirSync(join(dir, ".ddd"));
    writeFileSync(join(dir, ".ddd", "todos.json"), "{ not json");
    const p = await load("bad-2", dir);
    expect(p.todos).toEqual([]);
  });

  it("loads every card, in parallel, in registry order", async () => {
    const a = tempdir("all-a");
    const b = gitRepo("all-b");
    const cards = await loadAll([{ id: "a", path: a }, { id: "b", path: b }]);
    expect(cards.map((c) => c.id)).toEqual(["a", "b"]);
    expect(cards[1]!.git.isRepo).toBe(true);
  });
});
