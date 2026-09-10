import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { scratchEnv } from "./testing";
import { register, registry, shellexpandHome, slug, unregister } from "./projects";

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
