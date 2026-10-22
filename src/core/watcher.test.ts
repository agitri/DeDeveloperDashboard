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

  it("does not mistake a root containing .. for being outside another root", () => {
    // A sibling-named path like <root>/..cache must not trip the
    // "outside the root" check just because it starts with "..".
    const withDots = new Map<string, ProjectChanged>([["/tmp/..io", { environmentId: "work", projectId: "io-1" }]]);
    expect(routeFor(withDots, "/tmp/..io/.ddd/todos.json")?.projectId).toBe("io-1");
    expect(routeFor(withDots, "/tmp/other/.ddd/x")).toBeNull();
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

// How long each test waits after `sync()` before making its first write.
// `fs.watch({ recursive: true })` on macOS becomes live asynchronously —
// FSEvents startup latency — and libuv only streams changes from "now", so a
// write made before the watch is actually live is never delivered (nothing
// replays it later). 500ms comfortably clears that startup window.
const SETTLE_MS = 500;

// FSEvents startup latency (see SETTLE_MS above) can still occasionally
// outlast even that settle on a loaded machine, dropping a real first write
// outright — a platform property, harmless in real use, not a watcher bug.
// The tolerance belongs at the framework level, not inside the test body: a
// retry re-runs the whole test with fresh temp dirs and the same strict
// assertions, so a watcher that actually drops writes, double-emits, or
// misroutes still fails on every attempt.
describe("watching registered projects", { retry: 2 }, () => {
  let watcher: ProjectWatcher | null = null;
  afterEach(() => watcher?.close());

  it("emits one project-changed per project per burst when .ddd/ is written", async () => {
    const dir = tempdir("todo");
    mkdirSync(join(dir, ".ddd"));
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p1", path: dir }]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // An editor save is several events; a `/todo` is one file, twice.
    writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[]}');
    writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[{"id":"t","text":"x"}]}');
    await until(() => emitter.events.length > 0, 8000);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events).toEqual([{ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p1" } }]);
  }, 15000);

  it("notices the .ddd folder appearing on a project that had none", async () => {
    const dir = tempdir("appear");
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p2", path: dir }]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    mkdirSync(join(dir, ".ddd"));
    await until(() => emitter.events.length > 0, 8000);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events[0]).toEqual({ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p2" } });
  }, 15000);

  it("does not fire for edits outside .ddd/, and re-syncing an unchanged registry is a no-op", async () => {
    const dir = tempdir("outside");
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p3", path: dir }]);
    watcher.sync("work", [{ id: "p3", path: dir }]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    writeFileSync(join(dir, "README.md"), "hi");
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events).toEqual([]);
  });

  it("rebuilds after close() so a later sync of the same list watches again", async () => {
    const dir = tempdir("reclose");
    mkdirSync(join(dir, ".ddd"));
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    const list = [{ id: "p4", path: dir }];
    watcher.sync("work", list);
    watcher.close();
    // Same list: without registry.clear() in close(), sync() would hit its
    // "nothing changed" early return and never rebuild the watchers.
    watcher.sync("work", list);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[]}');
    await until(() => emitter.events.length > 0, 8000);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events[0]).toEqual({ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p4" } });
  }, 15000);

  it("watches the union across environments", async () => {
    const a = tempdir("env-a");
    const b = tempdir("env-b");
    mkdirSync(join(a, ".ddd"));
    mkdirSync(join(b, ".ddd"));
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "pa", path: a }]);
    watcher.sync("personal", [{ id: "pb", path: b }]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    writeFileSync(join(b, ".ddd", "recap.md"), "# recap");
    await until(() => emitter.events.length > 0, 8000);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events[0]!.payload).toEqual({ environmentId: "personal", projectId: "pb" });
    expect(emitter.events.some((e) => (e.payload as ProjectChanged).projectId === "pa")).toBe(false);
  }, 15000);
});
