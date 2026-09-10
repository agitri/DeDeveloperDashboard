import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingEmitter } from "./emitter";
import { DEBOUNCE_MS, isSelfNamedReplay, ProjectWatcher, routeFor, type ProjectChanged } from "./watcher";

const routes = () => new Map<string, ProjectChanged>([["/tmp/io", { environmentId: "work", projectId: "io-1" }]]);

describe("routing a changed path to its project", () => {
  it("routes changes inside the .ddd folder", () => {
    expect(routeFor(routes(), "/tmp/io/.ddd/todos.json")?.projectId).toBe("io-1");
  });

  it("ignores everything outside the .ddd folder", () => {
    // The shallow root watch (used before `.ddd` exists) sees unrelated
    // edits; they must not fire a reload.
    expect(routeFor(routes(), "/tmp/io/README.md")).toBeNull();
    expect(routeFor(routes(), "/tmp/other/.ddd/todos.json")).toBeNull();
    expect(routeFor(routes(), "/tmp/io-2/.ddd/todos.json")).toBeNull();
  });

  it("matches the .ddd folder itself appearing", () => {
    expect(routeFor(routes(), "/tmp/io/.ddd")).not.toBeNull();
  });
});

const tempdir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `ddd-watch-${name}-`)));

describe("phantom replay", () => {
  it("is true for a callback naming its own watched .ddd, when nothing really appeared there", () => {
    const root = tempdir("replay-1");
    const target = join(root, ".ddd");
    mkdirSync(target);
    expect(isSelfNamedReplay(target, ".ddd")).toBe(true);
  });

  it("is false once a real child named .ddd exists inside the watched .ddd", () => {
    const root = tempdir("replay-2");
    const target = join(root, ".ddd");
    mkdirSync(target);
    mkdirSync(join(target, ".ddd"));
    expect(isSelfNamedReplay(target, ".ddd")).toBe(false);
  });

  it("is false under a shallow root watch when .ddd really appeared under the root", () => {
    const root = tempdir("replay-3");
    mkdirSync(join(root, ".ddd"));
    // The folder appearing must never be dropped: a shallow watch on the
    // root reports it as (root, ".ddd"), and that is a real child, not a
    // replay of the root's own name.
    expect(isSelfNamedReplay(root, ".ddd")).toBe(false);
  });

  it("is false for an ordinary filename", () => {
    const root = tempdir("replay-4");
    const target = join(root, ".ddd");
    mkdirSync(target);
    expect(isSelfNamedReplay(target, "todos.json")).toBe(false);
  });
});

// Gives up loudly on timeout instead of quietly returning: a condition that
// never comes true should fail with a clear "timed out" error at the point
// that waited for it, not surface as a confusing mismatch (or an undefined
// dereference) several lines later.
const until = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 >= ms) throw new Error(`until: condition not met within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("watching registered projects", () => {
  let watcher: ProjectWatcher | null = null;
  afterEach(() => watcher?.close());

  it(
    "emits one project-changed per project per burst when .ddd/ is written",
    async () => {
      const dir = tempdir("todo");
      mkdirSync(join(dir, ".ddd"));
      const emitter = recordingEmitter();
      watcher = new ProjectWatcher(emitter);
      watcher.sync("work", [{ id: "p1", path: dir }]);
      await new Promise((r) => setTimeout(r, 250));

      // An editor save is several events; a `/todo` is one file, twice.
      writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[]}');
      writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[{"id":"t","text":"x"}]}');
      await until(() => emitter.events.length > 0, 8000);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
      expect(emitter.events).toEqual([{ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p1" } }]);
    },
    15000,
  );

  it(
    "notices the .ddd folder appearing on a project that had none",
    async () => {
      const dir = tempdir("appear");
      const emitter = recordingEmitter();
      watcher = new ProjectWatcher(emitter);
      watcher.sync("work", [{ id: "p2", path: dir }]);
      await new Promise((r) => setTimeout(r, 250));

      mkdirSync(join(dir, ".ddd"));
      await until(() => emitter.events.length > 0, 8000);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
      expect(emitter.events[0]).toEqual({ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p2" } });
    },
    15000,
  );

  it("does not fire for edits outside .ddd/, and re-syncing an unchanged registry is a no-op", async () => {
    const dir = tempdir("outside");
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p3", path: dir }]);
    watcher.sync("work", [{ id: "p3", path: dir }]);
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(join(dir, "README.md"), "hi");
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events).toEqual([]);
  });

  it(
    "watches the union across environments",
    async () => {
      const a = tempdir("env-a");
      const b = tempdir("env-b");
      mkdirSync(join(a, ".ddd"));
      mkdirSync(join(b, ".ddd"));
      const emitter = recordingEmitter();
      watcher = new ProjectWatcher(emitter);
      watcher.sync("work", [{ id: "pa", path: a }]);
      watcher.sync("personal", [{ id: "pb", path: b }]);
      await new Promise((r) => setTimeout(r, 250));
      writeFileSync(join(b, ".ddd", "recap.md"), "# recap");
      await until(() => emitter.events.length > 0, 8000);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
      expect(emitter.events[0]!.payload).toEqual({ environmentId: "personal", projectId: "pb" });
      expect(emitter.events.some((e) => (e.payload as ProjectChanged).projectId === "pa")).toBe(false);
    },
    15000,
  );
});
