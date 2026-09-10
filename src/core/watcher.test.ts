import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingEmitter } from "./emitter";
import { DEBOUNCE_MS, ProjectWatcher, routeFor, type ProjectChanged } from "./watcher";

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
// This sandbox's forked test workers occasionally drop the very first
// FSEvents notification for a fresh watch outright (verified separately
// against a plain, unsandboxed `node` process, where the same watch is
// reliable) — rare on a real machine, but reliably reproducible here.
const until = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};
// `nudge` repeats the filesystem change every 300ms until it is observed;
// since a burst of repeats of the same change is exactly what "one project
// per burst" already has to coalesce, this does not weaken what these two
// tests assert (they only look at `events[0]`, so a second, later burst from
// an overlapping nudge would not fail them).
const untilNudged = async (pred: () => boolean, nudge: () => void, ms = 8000) => {
  const t0 = Date.now();
  let last = 0;
  while (!pred() && Date.now() - t0 < ms) {
    if (Date.now() - last > 300) {
      nudge();
      last = Date.now();
    }
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
      await until(() => emitter.events.length > 0, 3000);
      // This test asserts an exact one-element array, so it cannot use the
      // repeated `untilNudged` (a nudge whose OS delivery is delayed past the
      // debounce window would register as a second, distinct burst). If
      // nothing arrived at all, one extra write is a single retry, not a
      // second burst, and by now any delayed original delivery has settled.
      if (emitter.events.length === 0) {
        writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[{"id":"t","text":"x"}]}');
        await until(() => emitter.events.length > 0, 5000);
      }
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
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
      // The root watch is shallow (non-recursive): it only sees direct
      // children of `dir` changing, so the nudge has to touch `.ddd` itself
      // (a fresh write inside it is a grandchild and would go unseen).
      await untilNudged(
        () => emitter.events.length > 0,
        () => utimesSync(join(dir, ".ddd"), new Date(), new Date()),
      );
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
      await untilNudged(
        () => emitter.events.length > 0,
        () => writeFileSync(join(b, ".ddd", "recap.md"), "# recap"),
      );
      expect(emitter.events[0]!.payload).toEqual({ environmentId: "personal", projectId: "pb" });
    },
    15000,
  );
});
