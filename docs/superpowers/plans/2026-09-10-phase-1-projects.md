# Phase 1 — Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Projects widgets work: register a directory, see its card (git status, recap, todos, ICM files), launch a terminal with Claude Code in it, open it in an editor, and have a `/todo` typed inside Claude Code reach the card within about a second.

**Architecture:** Three core modules ported one-to-one from the Rust (`projects.rs`, `launcher.rs`, `watcher.rs`), an `Emitter` interface that core services use to push events to the window, and the command registry turned into `createCommands(deps)` so main can hand it the emitter and the single app-wide watcher. Nine commands are added under their Tauri names; `ddd://project-changed` is the first backend-to-renderer event.

**Tech Stack:** Electron 44, TypeScript 5.8, vitest 5, `node:child_process` (`execFile` for git, detached `spawn` for terminals and editors), `node:fs` `watch` (recursive), same `~/.ddd` files as the Rust app.

**Spec:** `docs/superpowers/specs/2026-09-10-node-port-design.md` (§3 Emitter, §4 phase 1, §5 rows `projects.rs`, `launcher.rs`, `watcher.rs`)

## Global Constraints

- Source of truth for behaviour: `../DDD/src-tauri/src/{projects.rs,launcher.rs,watcher.rs,commands.rs,models.rs}` at commit `7fe0f68` (read-only). When in doubt, do what the Rust does and leave a comment.
- Nothing under `src/core/` may import `electron` (contract test). Core services that need to push an event take an `Emitter`; they never know about windows.
- Command names and argument keys are the Tauri ones: `projects_list({env})`, `project_register({env, path})`, `project_unregister({env, id})`, `project_reload({env, id})`, `project_launch({env, id})`, `launch_path({path})`, `open_in_editor({path, editor?})`, `editors_list()`, `terminals_list()`. Event `ddd://project-changed` with payload `{ environmentId, projectId }`.
- Error text crosses IPC verbatim: `<path> is not a directory` (notFound), `project "<id>"` (notFound), `empty terminal template` / `empty editor template` (config), `no editor is configured — set one in Settings → Appearance` (config), the Linux "no terminal could be launched (tried: …)" sentence (config).
- Every disk-touching test uses `scratchEnv()` or a `mkdtempSync` directory; nothing touches the real `~/.ddd` or spawns a visible window. Spawn tests use `/bin/sh -c "echo … > proof"` templates exactly as the Rust tests do.
- `git` must be on PATH for the projects tests (it is on this machine); tests create their own temp repositories.
- Commit after every task. End every commit message with these two trailer lines exactly, regardless of any other attribution guidance:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`
- No renderer changes. The renderer already calls these commands and listens for the event.

---

## File structure

```
src/core/emitter.ts            Emitter interface + recordingEmitter() for tests
src/core/models.ts             + Todo, TodoFile, ProjectConfig, ProductDecl, Deployment, GitStatus,
                                 ProjectRef, ProjectRegistry, Project, FoundApp and their fromJson
src/core/projects.ts           registry, register, unregister, slug, load, loadAll, gitStatus, identity, configOf
src/core/launcher.ts           resolveTerminal, shellQuote, writeLaunchScript, splitTemplate, launch,
                                 openInEditor, KNOWN_EDITORS, KNOWN_TERMINALS, detect*
src/core/watcher.ts            ProjectWatcher (one for the app), routeFor
src/main/commands.ts           createCommands(deps) — the nine new commands join the existing map
src/main/ipc.ts                registerIpc(commands)
src/main/index.ts              builds the emitter + watcher, extends the smoke
```

---

### Task 1: The Emitter seam

**Files:**
- Create: `src/core/emitter.ts`
- Modify: `src/main/commands.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/main/commands.test.ts`
- Test: `src/core/emitter.test.ts`

**Interfaces:**
- Produces: `interface Emitter { emit(name: string, payload: unknown): void }`; `recordingEmitter(): Emitter & { events: { name: string; payload: unknown }[] }`; `interface CommandDeps { emit: Emitter }` (Task 7 adds `watcher`); `createCommands(deps: CommandDeps): Record<string, Handler>`; `registerIpc(commands: Record<string, Handler>)`.
- The old `export const commands` is removed; every consumer calls `createCommands`.

- [ ] **Step 1: Write the failing tests**

`src/core/emitter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recordingEmitter } from "./emitter";

describe("recording emitter", () => {
  it("keeps every event in order", () => {
    const e = recordingEmitter();
    e.emit("ddd://project-changed", { environmentId: "work", projectId: "p1" });
    e.emit("ddd://items-changed", { environmentId: "work" });
    expect(e.events).toEqual([
      { name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p1" } },
      { name: "ddd://items-changed", payload: { environmentId: "work" } },
    ]);
  });
});
```

In `src/main/commands.test.ts`, change the import and every use of `commands`:

```ts
import { HOST_COMMANDS, createCommands } from "./commands";
import { recordingEmitter } from "../core/emitter";

const commands = createCommands({ emit: recordingEmitter() });
```

(The rest of the file stays as it is; `commands` is now a local built once at module load.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/emitter.test.ts src/main/commands.test.ts`
Expected: FAIL — cannot resolve `./emitter`; `createCommands` is not exported.

- [ ] **Step 3: Write emitter.ts**

`src/core/emitter.ts`:

```ts
/**
 * How the backend tells the window something changed. Events flow one way,
 * backend → renderer, for cache invalidation only (spec §3): the watcher
 * noticing a `.ddd/` write, the scheduler finishing a fetch.
 *
 * Core never sees a window: main implements this with `webContents.send`,
 * tests with an array.
 */
export interface Emitter {
  emit(name: string, payload: unknown): void;
}

export interface RecordedEvent {
  name: string;
  payload: unknown;
}

/** For tests: remembers every event, in order. */
export function recordingEmitter(): Emitter & { events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
    },
  };
}
```

- [ ] **Step 4: Turn the registry into a factory**

In `src/main/commands.ts`, add the import and replace the `export const commands: Record<string, Handler> = {` line and the closing `};` so the map is built by a function:

```ts
import type { Emitter } from "../core/emitter";

/** What the stateful commands need from the host. Main builds one of these;
 *  tests build one with a recording emitter. */
export interface CommandDeps {
  emit: Emitter;
}

export function createCommands(_deps: CommandDeps): Record<string, Handler> {
  return {
    // (the existing entries, unchanged, indented one level)
  };
}
```

`_deps` is unused until Task 7 adds the watcher; the underscore keeps `noUnusedParameters` quiet.

- [ ] **Step 5: Hand the built map to ipc.ts and index.ts**

`src/main/ipc.ts`: remove `import { commands } from "./commands";`, add `import type { Handler } from "./commands";`, and change the registration to

```ts
export function registerIpc(commands: Record<string, Handler>): void {
  ipcMain.handle("ddd:invoke", (event, cmd: unknown, args: unknown) => dispatch(cmd, args, event, host, commands));
}
```

`src/main/index.ts`: add

```ts
import { createCommands } from "./commands";
import type { Emitter } from "../core/emitter";

/** Every open window hears every event. There is one window today; the
 *  loop is what makes a second one free. */
const emitter: Emitter = {
  emit(name, payload) {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(name, payload);
  },
};
```

and in `app.whenReady().then(() => { … })` replace `registerIpc();` with `registerIpc(createCommands({ emit: emitter }));`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (233 tests: 232 + the new emitter test).

- [ ] **Step 7: Commit**

```bash
git add src/core/emitter.ts src/core/emitter.test.ts src/main/commands.ts src/main/ipc.ts src/main/index.ts src/main/commands.test.ts
git commit -m "feat(main): the Emitter seam — createCommands(deps) and one emitter for every window"
```

---

### Task 2: Project models and the registry

**Files:**
- Modify: `src/core/models.ts`
- Create: `src/core/projects.ts`
- Test: `src/core/projects.test.ts`

**Interfaces:**
- Consumes: `record`, `required`, `optional`, `isString`, `isBoolean`, `isNumber`, `isArray` from `src/core/json.ts`; `readJson`, `readJsonOpt`, `writeJson` from `src/core/store.ts`; `EnvRoot`, `DddFolder` from `src/core/paths.ts`; `DddError`.
- Produces (models): types `Todo`, `TodoFile`, `Deployment`, `ProductDecl`, `ProjectConfig` (core's own: the renderer's plus `products: ProductDecl[]`), `GitStatus`, `ProjectRef`, `ProjectRegistry`, `Project`, `FoundApp`; `todoFileFromJson(raw): TodoFile`, `projectConfigFromJson(raw): ProjectConfig`, `defaultProjectConfig()`, `projectRegistryFromJson(raw): ProjectRegistry`, `defaultGitStatus(): GitStatus`.
- Produces (projects): `registry(env): ProjectRegistry`, `register(env, path): ProjectRef`, `unregister(env, id): void`, `slug(path): string`, `shellexpandHome(path): string`.

- [ ] **Step 1: Write the failing test**

`src/core/projects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
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
    expect(slug("/tmp/p")).toBe("p-" + ((((5381n * 33n) ^ 47n) * 33n ^ 116n) * 33n ^ 109n) * 33n ^ 112n) * 33n ^ 47n) * 33n ^ 112n) & 0xffffffn).toString(16));
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
    require("node:fs").writeFileSync(env.projectsFile(), JSON.stringify({ projects: [{ id: "x", path: dir }] }));
    expect(registry(env).projects).toEqual([{ id: "x", path: dir }]);
  });
});
```

Replace the `require("node:fs").writeFileSync` line with a static `writeFileSync` import at the top (`import { …, writeFileSync } from "node:fs"`); it is written this way here only to keep the import list readable.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/projects.test.ts`
Expected: FAIL — cannot resolve `./projects`.

- [ ] **Step 3: Add the project models**

Append to `src/core/models.ts` (after the layout section). The renderer's `Project`, `GitStatus`, `Todo`, `Deployment`, `FoundApp`, `ProductDecl` types are re-exported; `ProjectConfig` is core's own because the Rust struct has a `products` field the renderer type omits.

```ts
// --- projects ------------------------------------------------------------------

import type { Deployment, FoundApp, GitStatus, ProductDecl, Todo } from "../renderer/src/types";
export type { Deployment, FoundApp, GitStatus, ProductDecl, Todo };

/** `<project>/.ddd/todos.json` */
export interface TodoFile {
  todos: Todo[];
}

/** `<project>/.ddd/config.json` — written by whoever registers the project.
 *  The renderer's type lacks `products`; the Rust struct has it. */
export interface ProjectConfig {
  name: string | null;
  repos: string[];
  deployments: Deployment[];
  terminal: string | null;
  products: ProductDecl[];
}

export interface ProjectRef {
  id: string;
  path: string;
}

export interface ProjectRegistry {
  projects: ProjectRef[];
}

/** Everything the project card needs, assembled on demand. Same shape as the
 *  renderer's `Project` with core's `ProjectConfig`. */
export interface Project {
  id: string;
  path: string;
  name: string;
  exists: boolean;
  config: ProjectConfig;
  git: GitStatus;
  recap: string | null;
  recapUpdatedAt: string | null;
  todos: Todo[];
  icmFiles: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function todoFromJson(raw: unknown): Todo {
  const o = record(raw, "todo");
  return {
    id: required(o, "id", isString),
    text: required(o, "text", isString),
    done: optional(o, "done", isBoolean, false),
    createdAt: optional(o, "createdAt", isString, null as string | null),
    source: optional(o, "source", isString, null as string | null),
  };
}

export function defaultTodoFile(): TodoFile {
  return { todos: [] };
}

export function todoFileFromJson(raw: unknown): TodoFile {
  const o = record(raw, "todos");
  return { todos: optional(o, "todos", isArray, [] as unknown[]).map(todoFromJson) };
}

export function deploymentFromJson(raw: unknown): Deployment {
  const o = record(raw, "deployment");
  return { name: required(o, "name", isString), url: required(o, "url", isString) };
}

/** Every field is read defensively: a config.json arrives with a repo, and a
 *  repo can come from anyone. Nothing here runs until approved (phase 6). */
export function productDeclFromJson(raw: unknown): ProductDecl {
  const o = record(raw, "product");
  return {
    id: required(o, "id", isString),
    name: optional(o, "name", isString, null as string | null),
    run: required(o, "run", isString),
    dir: optional(o, "dir", isString, null as string | null),
    port: optional(o, "port", isNumber, null as number | null),
  };
}

export function defaultProjectConfig(): ProjectConfig {
  return { name: null, repos: [], deployments: [], terminal: null, products: [] };
}

export function projectConfigFromJson(raw: unknown): ProjectConfig {
  const o = record(raw, "config");
  return {
    name: optional(o, "name", isString, null as string | null),
    repos: optional(o, "repos", isStringArray, [] as string[]),
    deployments: optional(o, "deployments", isArray, [] as unknown[]).map(deploymentFromJson),
    terminal: optional(o, "terminal", isString, null as string | null),
    products: optional(o, "products", isArray, [] as unknown[]).map(productDeclFromJson),
  };
}

export function projectRefFromJson(raw: unknown): ProjectRef {
  const o = record(raw, "project");
  return { id: required(o, "id", isString), path: required(o, "path", isString) };
}

export function defaultProjectRegistry(): ProjectRegistry {
  return { projects: [] };
}

export function projectRegistryFromJson(raw: unknown): ProjectRegistry {
  const o = record(raw, "registry");
  return { projects: optional(o, "projects", isArray, [] as unknown[]).map(projectRefFromJson) };
}

export function defaultGitStatus(): GitStatus {
  return { isRepo: false, branch: null, dirtyFiles: 0, ahead: 0, behind: 0, lastCommitSummary: null, lastCommitAt: null };
}
```

Move the `import type { … } from "../renderer/src/types"` line up to join the file's existing type import (one import statement), and make sure `isNumber` and `isArray` are among the helpers imported from `./json`.

- [ ] **Step 4: Write projects.ts (registry half)**

`src/core/projects.ts`:

```ts
/**
 * The projects registry and the `.ddd/` contract. Port of `projects.rs`.
 *
 * DDD watches the files that Claude Code writes — `todos.json` from `/todo`,
 * `recap.md` from the SessionEnd hook — and never writes them itself, which
 * keeps the coupling one-directional and loose.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";
import { readJson, writeJson } from "./store";
import { defaultProjectRegistry, projectRegistryFromJson, type ProjectRef, type ProjectRegistry } from "./models";

export function registry(env: EnvRoot): ProjectRegistry {
  return readJson(env.projectsFile(), projectRegistryFromJson, defaultProjectRegistry);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function register(env: EnvRoot, rawPath: string): ProjectRef {
  const path = shellexpandHome(rawPath);
  if (!isDir(path)) throw DddError.notFound(`${path} is not a directory`);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (e) {
    throw DddError.io(e);
  }

  const reg = registry(env);
  const existing = reg.projects.find((p) => p.path === canonical);
  if (existing) return existing;
  const entry: ProjectRef = { id: slug(canonical), path: canonical };
  reg.projects.push(entry);
  writeJson(env.projectsFile(), reg);
  return entry;
}

export function unregister(env: EnvRoot, id: string): void {
  const reg = registry(env);
  reg.projects = reg.projects.filter((p) => p.id !== id);
  writeJson(env.projectsFile(), reg);
}

/**
 * The lowercased folder name, non-alphanumerics dashed, plus a hash of the
 * whole path so two checkouts of the same repo name stay distinguishable.
 * The hash is the Rust's `fold(5381, |h, b| h.wrapping_mul(33) ^ b)` over the
 * UTF-8 bytes, in u64, masked to 24 bits — ids must match across the two apps.
 */
export function slug(path: string): string {
  const base = (basename(path) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
  let h = 5381n;
  for (const b of Buffer.from(path, "utf8")) {
    h = ((h * 33n) & 0xffffffffffffffffn) ^ BigInt(b);
  }
  return `${base}-${(h & 0xffffffn).toString(16)}`;
}

export function shellexpandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
```

Note the Rust lowercases the *whole* file name via `to_lowercase()` before mapping; `toLowerCase()` then the ASCII-only regex reproduces `is_ascii_alphanumeric` — a non-ASCII letter becomes `-` in both.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/core/projects.test.ts && npx tsc -p tsconfig.node.json`
Expected: 8 passed; tsc clean. If the djb2 test's expected value disagrees with `slug`, recompute it in the Rust way by hand for `/tmp/p` (bytes 47,116,109,112,47,112) — the implementation is the contract; fix the test's arithmetic, not the hash.

- [ ] **Step 6: Commit**

```bash
git add src/core/models.ts src/core/projects.ts src/core/projects.test.ts
git commit -m "feat(core): project models and the registry, ported from projects.rs"
```

---

### Task 3: Assembling a project card

**Files:**
- Modify: `src/core/projects.ts`
- Test: `src/core/projects.test.ts` (append)

**Interfaces:**
- Produces: `gitStatus(dir): Promise<GitStatus>`, `gitRemote(dir): Promise<string | null>`, `load(id, path): Promise<Project>`, `loadAll(entries): Promise<Project[]>`, `configOf(path): ProjectConfig`, `identity(id, path): { name: string; repos: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/projects.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { configOf, gitRemote, gitStatus, identity, load, loadAll } from "./projects";

function gitRepo(name: string): string {
  const dir = tempdir(name);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
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

  it("loads every card, in parallel, in registry order", async () => {
    const a = tempdir("all-a");
    const b = gitRepo("all-b");
    const cards = await loadAll([{ id: "a", path: a }, { id: "b", path: b }]);
    expect(cards.map((c) => c.id)).toEqual(["a", "b"]);
    expect(cards[1]!.git.isRepo).toBe(true);
  });
});
```

Add `basename` to the `node:path` import at the top of the test file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/projects.test.ts`
Expected: FAIL — `gitStatus`/`load`/… are not exported.

- [ ] **Step 3: Add the card half of projects.ts**

Append to `src/core/projects.ts` (and extend the imports: `readdirSync`, `readFileSync` from `node:fs`; `execFile` from `node:child_process`; `promisify` from `node:util`; `DddFolder` from `./paths`; `readJsonOpt` from `./store`; `defaultGitStatus`, `defaultProjectConfig`, `defaultTodoFile`, `projectConfigFromJson`, `todoFileFromJson`, and the types `GitStatus`, `Project`, `ProjectConfig` from `./models`):

```ts
const execFileAsync = promisify(execFile);

/** `git -C <dir> <args>`; stdout trimmed, or null when git fails or is absent.
 *  Shelled out rather than linked so the user's own git config (worktrees,
 *  includes) is honoured. */
async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])) !== "true") return defaultGitStatus();

  // `--porcelain` counts staged + unstaged + untracked in one shot.
  const porcelain = await git(dir, ["status", "--porcelain"]);
  const dirtyFiles = porcelain === null ? 0 : porcelain.split("\n").filter((l) => l !== "").length;

  // Fails on a repo with no upstream; absent counts are the honest answer.
  let ahead = 0;
  let behind = 0;
  const counts = await git(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts !== null) {
    const [b, a] = counts.split(/\s+/);
    const bn = Number(b);
    const an = Number(a);
    if (Number.isInteger(bn) && Number.isInteger(an)) {
      behind = bn;
      ahead = an;
    }
  }

  return {
    isRepo: true,
    branch: await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyFiles,
    ahead,
    behind,
    lastCommitSummary: await git(dir, ["log", "-1", "--pretty=%s"]),
    lastCommitAt: await git(dir, ["log", "-1", "--pretty=%cI"]),
  };
}

/** The `origin` remote of a checkout, if it has one. Read-only. */
export async function gitRemote(dir: string): Promise<string | null> {
  const url = await git(dir, ["remote", "get-url", "origin"]);
  return url ? url : null;
}

/** Just `<project>/.ddd/config.json`. Any failure is the default config: a
 *  repo can ship a broken file and the rest of the board must not care. */
export function configOf(path: string): ProjectConfig {
  try {
    const raw = readJsonOpt(DddFolder.of(path).config());
    return raw === null ? defaultProjectConfig() : projectConfigFromJson(raw);
  } catch {
    return defaultProjectConfig();
  }
}

/** Just enough to answer "is this project called X?" — no git, no recap. */
export function identity(id: string, path: string): { name: string; repos: string[] } {
  const config = configOf(path);
  return { name: config.name ?? (basename(path) || id), repos: config.repos };
}

/** Assemble one project card. A malformed config.json is an error here (the
 *  Rust's `read_json_opt(..)?`), unlike `configOf`. */
export async function load(id: string, path: string): Promise<Project> {
  const ddd = DddFolder.of(path);
  const exists = isDir(path);

  let config = defaultProjectConfig();
  if (exists) {
    const raw = readJsonOpt(ddd.config());
    if (raw !== null) config = projectConfigFromJson(raw);
  }

  let recap: string | null = null;
  let recapUpdatedAt: string | null = null;
  try {
    recap = readFileSync(ddd.recap(), "utf8");
    // The Rust writes chrono's RFC 3339 (`+00:00`, nanoseconds); this is the
    // same instant in ISO 8601 (`Z`, milliseconds). Readers parse both.
    recapUpdatedAt = statSync(ddd.recap()).mtime.toISOString();
  } catch {
    recap = null;
    recapUpdatedAt = null;
  }

  let todos = defaultTodoFile().todos;
  try {
    todos = readJson(ddd.todos(), todoFileFromJson, defaultTodoFile).todos;
  } catch {
    todos = [];
  }

  let icmFiles: string[] = [];
  try {
    icmFiles = readdirSync(ddd.icm())
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    icmFiles = [];
  }

  const name = config.name ?? (basename(path) || id);

  return {
    id,
    path,
    name,
    exists,
    config,
    git: exists ? await gitStatus(path) : defaultGitStatus(),
    recap,
    recapUpdatedAt,
    todos,
    icmFiles,
  };
}

/** Every card, in parallel: each costs three `git` subprocesses and they are
 *  independent. The Rust used scoped threads; `Promise.all` is the same shape,
 *  including "first failure fails the list". */
export function loadAll(entries: ProjectRef[]): Promise<Project[]> {
  return Promise.all(entries.map((e) => load(e.id, e.path)));
}
```

`sort()` on ASCII-only names matches Rust's byte-wise `sort()`; for non-ASCII names both are code-unit orders and differ only in exotic cases — leave a comment if you like, do not "fix" it with `localeCompare`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/projects.test.ts && npx tsc -p tsconfig.node.json`
Expected: 15 passed; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/projects.ts src/core/projects.test.ts
git commit -m "feat(core): project cards — git status, recap, todos and ICM listing"
```

---

### Task 4: The launcher — scripts, templates, terminals, editors

**Files:**
- Create: `src/core/launcher.ts`
- Test: `src/core/launcher.test.ts`

**Interfaces:**
- Produces: `resolveTerminal(projectPref, envPref): string | null`, `shellQuote(v): string`, `writeLaunchScript(dir, command): string` (path), `splitTemplate(t): string[]`, `launch(dir, terminal, command): Promise<void>`, `openInEditor(dir, editor): Promise<void>`, `spawnDetached(program, args): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (the Rust `launcher.rs` tests, ported)

`src/core/launcher.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, openInEditor, resolveTerminal, shellQuote, splitTemplate, writeLaunchScript } from "./launcher";

const tempdir = () => mkdtempSync(join(tmpdir(), "ddd-launcher-test-"));

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("terminal preference", () => {
  it("project wins over environment, blanks do not count", () => {
    expect(resolveTerminal("iTerm", "Terminal")).toBe("iTerm");
    expect(resolveTerminal(null, " Terminal ")).toBe("Terminal");
    expect(resolveTerminal("  ", null)).toBeNull();
    expect(resolveTerminal(null, null)).toBeNull();
  });
});

describe("the launch script", () => {
  it("quotes paths containing apostrophes", () => {
    // `~/Projects/Rene's stuff` is a perfectly ordinary directory name and
    // must not be able to break out of the generated script.
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("Rene's")).toBe("'Rene'\\''s'");
    expect(shellQuote("a b")).toBe("'a b'");
  });

  it("splits templates on whitespace honouring quotes", () => {
    expect(splitTemplate("wezterm start --cwd {dir} -- {cmd}")).toEqual(["wezterm", "start", "--cwd", "{dir}", "--", "{cmd}"]);
    expect(splitTemplate('term -e "claude --continue"')).toEqual(["term", "-e", "claude --continue"]);
  });

  it("lands in the directory and leaves a shell behind", () => {
    const dir = tmpdir();
    const path = writeLaunchScript(dir, "claude");
    const body = readFileSync(path, "utf8");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain(`cd ${shellQuote(dir)}`);
    expect(body).toContain("\nclaude\n");
    // Without this the window would slam shut on whatever Claude printed.
    expect(body).toContain('exec "${SHELL:-/bin/sh}" -l');
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
    rmSync(path);
  });
});

describe("launching", () => {
  it("the template branch substitutes and spawns", async () => {
    // Exercises the full template path — the one Linux and Windows users fall
    // back to — without opening a window.
    const dir = tempdir();
    const proof = join(dir, "proof.txt");
    await launch(dir, `/bin/sh -c "echo {cmd} > ${proof}"`, "launched-ok");
    await waitFor(proof);
    expect(readFileSync(proof, "utf8").trim()).toBe("launched-ok");
    rmSync(dir, { recursive: true });
  });

  it("refuses a directory that is not there", async () => {
    const missing = join(tmpdir(), "ddd-definitely-not-here");
    await expect(launch(missing, null, "claude")).rejects.toThrow(`${missing} is not a directory`);
  });

  it("refuses an empty template", async () => {
    await expect(launch(tmpdir(), "{dir}".replace("{dir}", ""), "claude")).rejects.toThrow();
    await expect(launch(tmpdir(), '"" {cmd}'.slice(3), "claude")).rejects.toThrow();
  });
});

describe("opening an editor", () => {
  it("refuses with no editor configured, pointing at Settings", async () => {
    // Silence, or a guessed default, would be worse: the user clicked a
    // button and nothing would happen with no way to find out why.
    await expect(openInEditor(tmpdir(), null)).rejects.toThrow(/Settings/);
    await expect(openInEditor(tmpdir(), "   ")).rejects.toThrow(/Settings/);
  });

  it("refuses a directory that is not there", async () => {
    const missing = join(tmpdir(), "ddd-editor-definitely-not-here");
    await expect(openInEditor(missing, "code")).rejects.toThrow(`${missing} is not a directory`);
  });

  it("an editor template substitutes the directory and spawns", async () => {
    const dir = tempdir();
    const proof = join(dir, "editor-proof.txt");
    await openInEditor(dir, `/bin/sh -c "echo {dir} > ${proof}"`);
    await waitFor(proof);
    expect(readFileSync(proof, "utf8").trim()).toBe(dir);
    rmSync(dir, { recursive: true });
  });
});
```

The "refuses an empty template" case is contrived on purpose: a template that contains `{dir}`/`{cmd}` but splits to nothing (`"" {cmd}` minus its first three characters is `{cmd}` — a one-part template that spawns `claude`; that is NOT empty). Replace that `it` with this exact one instead:

```ts
  it("refuses an empty template", async () => {
    await expect(launch(tmpdir(), "'' {cmd}".slice(0, 2) + " {cmd}".slice(0, 0) + "{cmd}".replace("{cmd}", "''"), "claude")).rejects.toThrow("empty terminal template");
  });
```

If that reads as too clever, the simplest honest form is: a template whose only parts are an empty quoted string plus a placeholder that substitutes to empty — `launch(dir, "'' {cmd}", "")` gives parts `["", ""]`; the Rust would spawn a program named `""` and fail with an io error, not "empty". So the truly empty case is a template of only quotes: `launch(tmpdir(), "'' {cmd}".slice(0, 2), "claude")` — but that has no placeholder and takes the platform path. Conclusion: an empty template is unreachable through `launch` (the placeholder check guarantees at least one part), exactly as in the Rust. **Drop the "refuses an empty template" test entirely** and note in the report that the branch is unreachable, mirrored from the Rust.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/launcher.test.ts`
Expected: FAIL — cannot resolve `./launcher`.

- [ ] **Step 3: Write launcher.ts**

`src/core/launcher.ts`:

```ts
/**
 * Opening a terminal in a project and starting Claude Code, and opening a
 * project in an editor. Port of `launcher.rs`.
 *
 * Terminals disagree about almost everything on the command line, so rather
 * than encoding six dialects, we write a tiny shell script and hand that to the
 * terminal — every terminal on earth knows how to run a script.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { DddError } from "./error";
import type { FoundApp } from "./models";

/** Where the terminal preference came from, in precedence order. */
export function resolveTerminal(projectPref: string | null | undefined, envPref: string | null | undefined): string | null {
  const chosen = (projectPref ?? envPref ?? "").trim();
  return chosen === "" ? null : chosen;
}

/** POSIX single-quoting: wrap in quotes and turn each `'` into `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A script that lands you in the project directory with Claude Code running,
 *  and — crucially — leaves you at a shell when it exits instead of slamming
 *  the window shut on whatever it printed. */
export function writeLaunchScript(dir: string, command: string): string {
  const script = `#!/bin/sh\ncd ${shellQuote(dir)} || exit 1\n${command}\nexec "\${SHELL:-/bin/sh}" -l\n`;
  const name = `ddd-launch-${(basename(dir) || "project").replace(/[^A-Za-z0-9]/g, "-")}.command`;
  const path = join(tmpdir(), name);
  try {
    writeFileSync(path, script);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  } catch (e) {
    throw DddError.io(e);
  }
  return path;
}

/** Split a template on whitespace, honouring quoted segments — enough of a
 *  shell parser for `wezterm start --cwd {dir} -- {cmd}`. */
export function splitTemplate(template: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of template) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Start a program and let go of it. Resolves once the process exists,
 *  rejects if it could not be started — the Rust's `Command::spawn()`. */
export function spawnDetached(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", (e) => reject(DddError.io(e)));
  });
}

function templateParts(template: string, substitute: (part: string) => string, emptyMessage: string): [string, string[]] {
  const parts = splitTemplate(template).map(substitute);
  const [program, ...args] = parts;
  if (program === undefined) throw DddError.config(emptyMessage);
  return [program, args];
}

export async function launch(dir: string, terminal: string | null | undefined, command: string): Promise<void> {
  if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);

  // A preference containing a placeholder is a full command template, and the
  // user is telling us they know their terminal better than we do.
  if (terminal && (terminal.includes("{dir}") || terminal.includes("{cmd}"))) {
    const [program, args] = templateParts(
      terminal,
      (part) => part.replaceAll("{dir}", dir).replaceAll("{cmd}", command),
      "empty terminal template",
    );
    await spawnDetached(program, args);
    return;
  }

  await launchPlatform(dir, terminal ?? null, command);
}

async function launchPlatform(dir: string, terminal: string | null, command: string): Promise<void> {
  if (process.platform === "darwin") {
    const script = writeLaunchScript(dir, command);
    // `open -a` hands the .command file to the terminal app, which runs it —
    // this works identically for Terminal.app, iTerm2 and friends.
    await spawnDetached("open", ["-a", terminal ?? "Terminal", script]);
    return;
  }

  if (process.platform === "win32") {
    // Windows Terminal takes a working directory directly, which is by far the
    // cleanest path when it is present. Written blind, as the Rust was.
    if (terminal === null || terminal === "wt") {
      try {
        await spawnDetached("wt", ["-d", dir, "cmd", "/K", command]);
        return;
      } catch {
        // fall through to cmd
      }
    }
    await spawnDetached("cmd", ["/C", "start", "", terminal ?? "cmd", "/K", `cd /d ${dir} && ${command}`]);
    return;
  }

  // Linux: the configured terminal, else $TERMINAL, else the usual suspects.
  const script = writeLaunchScript(dir, command);
  const candidates = terminal
    ? [terminal]
    : [
        ...(process.env.TERMINAL ? [process.env.TERMINAL] : []),
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "wezterm",
        "alacritty",
        "kitty",
        "xfce4-terminal",
        "xterm",
      ];
  for (const candidate of candidates) {
    // gnome-terminal dropped `-e` in favour of `--`; everything else kept `-e`.
    const separator = candidate.includes("gnome-terminal") ? "--" : "-e";
    try {
      await spawnDetached(candidate, [separator, script]);
      return;
    } catch {
      // try the next one
    }
  }
  throw DddError.config(
    `no terminal could be launched (tried: ${candidates.join(", ")}). Set one in Settings → Appearance, ` +
      "or use a template like `alacritty --working-directory {dir} -e {cmd}`.",
  );
}

// ---------------------------------------------------------------------------
// Finding the apps a developer already has
// ---------------------------------------------------------------------------

/** An app DDD knows how to find and hand a directory to. Catalogs make the
 *  common case one click; anything installed stays reachable by name. */
export interface KnownApp {
  id: string;
  name: string;
  /** macOS bundle name without `.app`; empty when there is no bundle. */
  bundle: string;
  /** CLI launcher on Linux and Windows; empty when there is none. */
  cli: string;
}

export const KNOWN_EDITORS: readonly KnownApp[] = [
  { id: "vscode", name: "VS Code", bundle: "Visual Studio Code", cli: "code" },
  { id: "cursor", name: "Cursor", bundle: "Cursor", cli: "cursor" },
  { id: "zed", name: "Zed", bundle: "Zed", cli: "zed" },
  { id: "phpstorm", name: "PhpStorm", bundle: "PhpStorm", cli: "pstorm" },
  { id: "webstorm", name: "WebStorm", bundle: "WebStorm", cli: "webstorm" },
  { id: "idea", name: "IntelliJ IDEA", bundle: "IntelliJ IDEA", cli: "idea" },
  { id: "pycharm", name: "PyCharm", bundle: "PyCharm", cli: "pycharm" },
  { id: "goland", name: "GoLand", bundle: "GoLand", cli: "goland" },
  { id: "rustrover", name: "RustRover", bundle: "RustRover", cli: "rustrover" },
  { id: "sublime", name: "Sublime Text", bundle: "Sublime Text", cli: "subl" },
  { id: "xcode", name: "Xcode", bundle: "Xcode", cli: "xed" },
  { id: "androidstudio", name: "Android Studio", bundle: "Android Studio", cli: "studio" },
];

/** Terminals, in rough order of "if you installed this, you meant it".
 *  Terminal.app is last precisely because everyone has it. */
export const KNOWN_TERMINALS: readonly KnownApp[] = [
  { id: "iterm", name: "iTerm", bundle: "iTerm", cli: "" },
  { id: "ghostty", name: "Ghostty", bundle: "Ghostty", cli: "ghostty" },
  { id: "warp", name: "Warp", bundle: "Warp", cli: "" },
  { id: "wezterm", name: "WezTerm", bundle: "WezTerm", cli: "wezterm" },
  { id: "alacritty", name: "Alacritty", bundle: "Alacritty", cli: "alacritty" },
  { id: "kitty", name: "kitty", bundle: "kitty", cli: "kitty" },
  { id: "hyper", name: "Hyper", bundle: "Hyper", cli: "hyper" },
  { id: "gnome-terminal", name: "GNOME Terminal", bundle: "", cli: "gnome-terminal" },
  { id: "konsole", name: "Konsole", bundle: "", cli: "konsole" },
  { id: "xfce4-terminal", name: "Xfce Terminal", bundle: "", cli: "xfce4-terminal" },
  { id: "terminal", name: "Terminal", bundle: "Terminal", cli: "" },
];

/** Where macOS keeps applications. `/System/Applications/Utilities` is where
 *  Terminal.app has lived since Catalina. */
export const MAC_APP_ROOTS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];

function onPath(command: string): boolean {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return paths.some((dir) => {
    try {
      return statSync(join(dir, command)).isFile() || statSync(join(dir, command + ".exe")).isFile();
    } catch {
      return false;
    }
  });
}

function appTarget(app: KnownApp, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") {
    // `open -a` needs only the bundle name, and works whether or not the user
    // ever installed a CLI launcher.
    if (app.bundle === "") return null;
    return MAC_APP_ROOTS.some((root) => existsSync(join(root, `${app.bundle}.app`))) ? app.bundle : null;
  }
  if (app.cli === "") return null;
  return onPath(app.cli) ? app.cli : null;
}

/** Which apps in a catalog are installed. Best-effort: never errors. */
export function detect(catalog: readonly KnownApp[], platform: NodeJS.Platform = process.platform): FoundApp[] {
  const found: FoundApp[] = [];
  for (const app of catalog) {
    const target = appTarget(app, platform);
    if (target !== null) found.push({ id: app.id, name: app.name, target });
  }
  return found;
}

export const detectEditors = (): FoundApp[] => detect(KNOWN_EDITORS);
export const detectTerminals = (): FoundApp[] => detect(KNOWN_TERMINALS);

/** Open a directory in an editor: no script, no shell dialect — an editor
 *  takes a directory and that is the whole interface. */
export async function openInEditor(dir: string, editor: string | null | undefined): Promise<void> {
  if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);
  const chosen = (editor ?? "").trim();
  if (chosen === "") throw DddError.config("no editor is configured — set one in Settings → Appearance");

  if (chosen.includes("{dir}")) {
    const [program, args] = templateParts(chosen, (part) => part.replaceAll("{dir}", dir), "empty editor template");
    await spawnDetached(program, args);
    return;
  }

  if (process.platform === "darwin") {
    await spawnDetached("open", ["-a", chosen, dir]);
    return;
  }
  try {
    await spawnDetached(chosen, [dir]);
  } catch (e) {
    throw DddError.config(`could not start ${chosen}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/launcher.test.ts && npx tsc -p tsconfig.node.json`
Expected: 9 passed (after dropping the empty-template test); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/launcher.ts src/core/launcher.test.ts
git commit -m "feat(core): the launcher — launch scripts, templates, terminals and editors, ported from launcher.rs"
```

---

### Task 5: Catalog tests

**Files:**
- Test: `src/core/launcher.test.ts` (append)

The catalogs and `detect` were written in Task 4; this task ports the Rust's catalog tests so they are pinned.

- [ ] **Step 1: Write the tests**

Append to `src/core/launcher.test.ts`:

```ts
import { KNOWN_EDITORS, KNOWN_TERMINALS, MAC_APP_ROOTS, detect, detectEditors, detectTerminals } from "./launcher";

describe("the app catalogs", () => {
  it("have unique ids", () => {
    for (const catalog of [KNOWN_EDITORS, KNOWN_TERMINALS]) {
      const ids = catalog.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every entry is findable on some platform", () => {
    // An entry with neither a bundle nor a CLI can never be detected anywhere,
    // which makes it a typo rather than a catalog row.
    for (const app of [...KNOWN_EDITORS, ...KNOWN_TERMINALS]) {
      expect(app.bundle !== "" || app.cli !== "", app.name).toBe(true);
    }
  });

  it("detection never throws and returns only catalog entries", () => {
    for (const [catalog, found] of [[KNOWN_EDITORS, detectEditors()], [KNOWN_TERMINALS, detectTerminals()]] as const) {
      for (const app of found) {
        expect(catalog.some((k) => k.id === app.id), app.id).toBe(true);
        expect(app.target).not.toBe("");
      }
    }
  });

  it("on macOS the target is the bundle name and the bundle is present", () => {
    if (process.platform !== "darwin") return;
    for (const app of detect([...KNOWN_EDITORS, ...KNOWN_TERMINALS], "darwin")) {
      const known = [...KNOWN_EDITORS, ...KNOWN_TERMINALS].find((k) => k.id === app.id)!;
      expect(app.target).toBe(known.bundle);
      expect(MAC_APP_ROOTS.some((root) => existsSync(join(root, `${known.bundle}.app`)))).toBe(true);
    }
    // Terminal.app ships with every Mac.
    expect(detectTerminals().some((a) => a.id === "terminal")).toBe(true);
  });

  it("off macOS, an app with no CLI is never offered", () => {
    expect(detect([{ id: "x", name: "X", bundle: "X", cli: "" }], "linux")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `npx vitest run src/core/launcher.test.ts`
Expected: 14 passed.

```bash
git add src/core/launcher.test.ts
git commit -m "test(core): pin the editor and terminal catalogs"
```

---

### Task 6: The `.ddd/` watcher

**Files:**
- Create: `src/core/watcher.ts`
- Test: `src/core/watcher.test.ts`

**Interfaces:**
- Consumes: `Emitter` (Task 1), `ProjectRef` (Task 2).
- Produces: `interface ProjectChanged { environmentId: string; projectId: string }`; `class ProjectWatcher { constructor(emit: Emitter); sync(environmentId: string, projects: ProjectRef[]): void; close(): void }`; `routeFor(routes: Map<string, ProjectChanged>, path: string): ProjectChanged | null`; `DEBOUNCE_MS = 400`.

- [ ] **Step 1: Write the failing tests**

`src/core/watcher.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};

describe("watching registered projects", () => {
  let watcher: ProjectWatcher | null = null;
  afterEach(() => watcher?.close());

  it("emits one project-changed per project per burst when .ddd/ is written", async () => {
    const dir = tempdir("todo");
    mkdirSync(join(dir, ".ddd"));
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p1", path: dir }]);
    await new Promise((r) => setTimeout(r, 100));

    // An editor save is several events; a `/todo` is one file, twice.
    writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[]}');
    writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[{"id":"t","text":"x"}]}');
    await until(() => emitter.events.length > 0);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
    expect(emitter.events).toEqual([{ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p1" } }]);
  });

  it("notices the .ddd folder appearing on a project that had none", async () => {
    const dir = tempdir("appear");
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p2", path: dir }]);
    await new Promise((r) => setTimeout(r, 100));

    mkdirSync(join(dir, ".ddd"));
    await until(() => emitter.events.length > 0);
    expect(emitter.events[0]).toEqual({ name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p2" } });
  });

  it("does not fire for edits outside .ddd/, and re-syncing an unchanged registry is a no-op", async () => {
    const dir = tempdir("outside");
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "p3", path: dir }]);
    watcher.sync("work", [{ id: "p3", path: dir }]);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(dir, "README.md"), "hi");
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
    expect(emitter.events).toEqual([]);
  });

  it("watches the union across environments", async () => {
    const a = tempdir("env-a");
    const b = tempdir("env-b");
    mkdirSync(join(a, ".ddd"));
    mkdirSync(join(b, ".ddd"));
    const emitter = recordingEmitter();
    watcher = new ProjectWatcher(emitter);
    watcher.sync("work", [{ id: "pa", path: a }]);
    watcher.sync("personal", [{ id: "pb", path: b }]);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(b, ".ddd", "recap.md"), "# recap");
    await until(() => emitter.events.length > 0);
    expect(emitter.events[0]!.payload).toEqual({ environmentId: "personal", projectId: "pb" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/watcher.test.ts`
Expected: FAIL — cannot resolve `./watcher`.

- [ ] **Step 3: Write watcher.ts**

`src/core/watcher.ts`:

```ts
/**
 * Watching each registered project's `.ddd/` folder. Port of `watcher.rs`.
 *
 * `/todo` inside Claude Code appends to `todos.json`, and the SessionEnd hook
 * writes `recap.md`. Neither of those knows DDD exists — so DDD watches the
 * files instead of being told about them. That is the whole coupling: one
 * side writes, the other side notices.
 */
import { watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Emitter } from "./emitter";
import type { ProjectRef } from "./models";

/** Filesystem events arrive in bursts — an editor save is three of them — and
 *  re-reading every project card per event would be silly. */
export const DEBOUNCE_MS = 400;

/** Payload of the `ddd://project-changed` event. */
export interface ProjectChanged {
  environmentId: string;
  projectId: string;
}

/** Map a changed path back to the project that owns it, ignoring anything
 *  outside `.ddd/` so a shallow root watch does not fire on unrelated edits. */
export function routeFor(routes: Map<string, ProjectChanged>, path: string): ProjectChanged | null {
  for (const [root, changed] of routes) {
    const rest = relative(root, path);
    if (rest === "" || rest.startsWith("..")) continue;
    if (rest.split(sep)[0] === ".ddd") return changed;
  }
  return null;
}

export class ProjectWatcher {
  /** Every environment's registered projects. Watching is global even though
   *  the registries are not, so the union has to live in one place. */
  private registry = new Map<string, ProjectRef[]>();
  private watchers: FSWatcher[] = [];
  private pending = new Map<string, ProjectChanged>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly emitter: Emitter) {}

  /** Record this environment's projects and re-point the watcher at the union.
   *  Called on every `projects_list`, which the widget polls — so it returns
   *  early when nothing changed. */
  sync(environmentId: string, projects: ProjectRef[]): void {
    const current = this.registry.get(environmentId);
    if (current && JSON.stringify(current) === JSON.stringify(projects)) return;
    this.registry.set(environmentId, projects.map((p) => ({ id: p.id, path: p.path })));

    const routes = new Map<string, ProjectChanged>();
    for (const [envId, entries] of this.registry) {
      for (const project of entries) routes.set(project.path, { environmentId: envId, projectId: project.id });
    }
    this.rebuild(routes);
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  /** Rebuilt wholesale whenever the registry changes; simpler than diffing,
   *  and the registry changes about once a week. */
  private rebuild(routes: Map<string, ProjectChanged>): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];

    for (const root of routes.keys()) {
      const ddd = join(root, ".ddd");
      // Watch `.ddd` recursively when it exists; otherwise the project root
      // shallowly, so the folder appearing is itself noticed. Shallow keeps
      // node_modules out.
      const target = isDir(ddd) ? ddd : root;
      const recursive = target === ddd;
      try {
        const w = watch(target, { recursive }, (_event, filename) => {
          const changedPath = filename ? join(target, filename.toString()) : target;
          const changed = routeFor(routes, changedPath);
          if (changed) this.queue(changed);
        });
        w.on("error", () => {
          /* a vanished directory stops its own watch; the others live on */
        });
        this.watchers.push(w);
      } catch {
        // Cannot watch this one (gone, or permissions): the others still work.
      }
    }
  }

  /** One notification per project per burst, not per file. */
  private queue(changed: ProjectChanged): void {
    this.pending.set(changed.projectId, changed);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const c of batch) this.emitter.emit("ddd://project-changed", c);
    }, DEBOUNCE_MS);
  }
}

function isDir(path: string): boolean {
  try {
    return require("node:fs").statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

Replace the `require("node:fs").statSync` with a proper `statSync` import from `node:fs` (add it to the existing import line); it is written inline above only to keep the listing short.

Note on recursion: when `.ddd` appears under a shallow root watch, the watch is not upgraded to recursive until the next `sync` with a changed registry. The Rust has the same limitation (the debouncer's watch set is only rebuilt in `sync`). Leave a comment; do not add an upgrade path in this task.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/watcher.test.ts && npx tsc -p tsconfig.node.json`
Expected: 7 passed; tsc clean. The live tests rely on `fs.watch`; on macOS they should settle well under a second. If the "appearing" test is flaky, increase the initial settle wait in that test from 100 to 250 ms and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add src/core/watcher.ts src/core/watcher.test.ts
git commit -m "feat(core): the .ddd/ watcher — one union across environments, debounced, ported from watcher.rs"
```

---

### Task 7: The nine commands, the smoke, and the README

**Files:**
- Modify: `src/main/commands.ts`, `src/main/commands.test.ts`, `src/main/index.ts`, `README.md`

**Interfaces:**
- `CommandDeps` gains `watcher: ProjectWatcher`.
- Registered: `projects_list`, `project_register`, `project_unregister`, `project_reload`, `project_launch`, `launch_path`, `open_in_editor`, `editors_list`, `terminals_list`.

- [ ] **Step 1: Write the failing tests**

In `src/main/commands.test.ts`, build deps with a watcher and extend the tests:

```ts
import { ProjectWatcher } from "../core/watcher";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const emitter = recordingEmitter();
const commands = createCommands({ emit: emitter, watcher: new ProjectWatcher(emitter) });
```

Remove these nine names from `NOT_YET_PORTED`: `projects_list`, `project_register`, `project_unregister`, `editors_list`, `terminals_list`, `launch_path`, `open_in_editor`, `project_reload`, `project_launch`.

Add:

```ts
describe("project commands", () => {
  it("register, list, reload, unregister — with the Tauri argument keys", async () => {
    scratchEnv("registry-projects");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-proj-")));
    mkdirSync(join(dir, ".ddd"));
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ name: "Cmd" }));

    expect(await commands.projects_list!({ env: "default" })).toEqual([]);
    const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string; name: string; exists: boolean };
    expect(card.name).toBe("Cmd");
    expect(card.exists).toBe(true);
    const listed = (await commands.projects_list!({ env: "default" })) as { id: string }[];
    expect(listed.map((p) => p.id)).toEqual([card.id]);
    const reloaded = (await commands.project_reload!({ env: "default", id: card.id })) as { name: string };
    expect(reloaded.name).toBe("Cmd");
    await expect(commands.project_reload!({ env: "default", id: "nope" })).rejects.toThrow('project "nope"');
    await commands.project_unregister!({ env: "default", id: card.id });
    expect(await commands.projects_list!({ env: "default" })).toEqual([]);
  });

  it("lists editors and terminals without throwing", async () => {
    expect(Array.isArray(await commands.editors_list!({}))).toBe(true);
    expect(Array.isArray(await commands.terminals_list!({}))).toBe(true);
  });

  it("launching a project logs an event and honours a project's own terminal template", async () => {
    const { env } = scratchEnv("registry-launch");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-launch-")));
    const proof = join(dir, "proof.txt");
    mkdirSync(join(dir, ".ddd"));
    // The project's config wins over the global terminal, and a template is
    // a full command — so this launches nothing visible.
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ terminal: `/bin/sh -c "echo {cmd} > ${proof}"` }));
    const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string };
    await commands.project_launch!({ env: "default", id: card.id });
    for (let i = 0; i < 50 && !existsSync(proof); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(proof, "utf8").trim()).toBe("claude");
    const rows = (await commands.events_query!({ env: "default", kindPrefix: "project." })) as { kind: string; project: string }[];
    expect(rows[0]).toMatchObject({ kind: "project.launch", project: basename(dir) });
    void env;
  });

  it("refuses to launch or open what is not there", async () => {
    await expect(commands.launch_path!({ path: "/nowhere/at/all" })).rejects.toThrow("is not a directory");
    await expect(commands.open_in_editor!({ path: "/nowhere/at/all" })).rejects.toThrow("is not a directory");
  });
});
```

Add `basename` to the `node:path` import and `existsSync`, `readFileSync` to the `node:fs` import in the test file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/commands.test.ts`
Expected: FAIL — `commands.projects_list` is not a function; the Tauri-contract test fails on the nine names now missing from `NOT_YET_PORTED`.

- [ ] **Step 3: Register the commands**

In `src/main/commands.ts`:

```ts
import * as projects from "../core/projects";
import * as launcher from "../core/launcher";
import type { ProjectWatcher } from "../core/watcher";
import type { EventInput } from "../core/models";

export interface CommandDeps {
  emit: Emitter;
  /** One watcher for the whole app: the set of watched paths is the union
   *  across environments, even though the registries themselves are not. */
  watcher: ProjectWatcher;
}
```

Rename the parameter to `deps` and add inside the returned map:

```ts
    // --- projects ---
    /** Listing also re-points the file watcher. Doing it here means the watch
     *  set can never drift from what the board is actually showing. */
    projects_list: async ({ env }) => {
      const r = root(env);
      const reg = projects.registry(r);
      try {
        deps.watcher.sync(r.id, reg.projects);
      } catch {
        // A watch that cannot be set up must not take the list with it.
      }
      return projects.loadAll(reg.projects);
    },
    project_register: async ({ env, path }) => {
      const r = root(env);
      const entry = projects.register(r, path);
      try {
        deps.watcher.sync(r.id, projects.registry(r).projects);
      } catch {
        /* see projects_list */
      }
      return projects.load(entry.id, entry.path);
    },
    project_unregister: ({ env, id }) => {
      const r = root(env);
      projects.unregister(r, id);
      try {
        deps.watcher.sync(r.id, projects.registry(r).projects);
      } catch {
        /* see projects_list */
      }
    },
    project_reload: ({ env, id }) => {
      const entry = findProject(root(env), id);
      return projects.load(entry.id, entry.path);
    },
    /** Open the configured terminal in the project and start Claude Code.
     *  The project's own `.ddd/config.json` wins over the global setting. */
    project_launch: async ({ env, id }) => {
      const r = root(env);
      const entry = findProject(r, id);
      const project = await projects.load(entry.id, entry.path);
      const appearance = globalLoad().appearance;
      const terminal = launcher.resolveTerminal(project.config.terminal, appearance.terminalApp);
      await launcher.launch(entry.path, terminal, appearance.launchCommand);
      const event: EventInput = { kind: "project.launch", source: "local", project: project.name };
      events.log(r, event);
    },
    /** The path-based sibling of `project_launch`, for the launcher widget. */
    launch_path: ({ path }) => {
      const appearance = globalLoad().appearance;
      return launcher.launch(path, appearance.terminalApp, appearance.launchCommand);
    },
    editors_list: () => launcher.detectEditors(),
    terminals_list: () => launcher.detectTerminals(),
    /** An explicit choice wins; otherwise the global default. */
    open_in_editor: ({ path, editor }) => {
      const configured = globalLoad().appearance.editor;
      const explicit = typeof editor === "string" ? editor.trim() : "";
      return launcher.openInEditor(path, explicit !== "" ? explicit : configured);
    },
```

and, above `createCommands`, the one helper the Rust inlines twice:

```ts
function findProject(env: EnvRoot, id: string) {
  const entry = projects.registry(env).projects.find((p) => p.id === id);
  if (!entry) throw DddError.notFound(`project ${JSON.stringify(id)}`);
  return entry;
}
```

(`DddError` import from `../core/error`.) `events.log` is the raw logger, as the Rust's `project_launch` calls `events::log` directly — not the opt-out-aware `eventLog`.

- [ ] **Step 4: Wire the watcher in main and extend the smoke**

`src/main/index.ts`: import `ProjectWatcher` from `../core/watcher`; after the emitter, `const watcher = new ProjectWatcher(emitter);` and `registerIpc(createCommands({ emit: emitter, watcher }));`. In `smoke()`, after the `secret_exists` check:

```ts
      const none = (await invoke("projects_list", { env: "default" })) as unknown[];
      if (none.length !== 0) throw new Error(`projects_list: expected 0, got ${none.length}`);
      const home = process.env.DDD_HOME!;
      const card = (await invoke("project_register", { env: "default", path: home })) as { exists: boolean; git: { isRepo: boolean } };
      if (!card.exists || card.git.isRepo) throw new Error(`project_register: unexpected card ${JSON.stringify(card)}`);
      const one = (await invoke("projects_list", { env: "default" })) as unknown[];
      if (one.length !== 1) throw new Error(`projects_list: expected 1, got ${one.length}`);
      await invoke("editors_list");
      await invoke("terminals_list");
```

and add `projects (register/list)` to the final `ddd: smoke ok` line.

- [ ] **Step 5: README**

In `README.md`'s phase table, mark phase 1 **done** with the sentence "projects, launcher, `.ddd/` watching: register a folder, launch Claude Code in it, `/todo` reaches the card".

- [ ] **Step 6: Full verification**

Run: `npm test && npm run typecheck && DDD_SMOKE_SHOT=/tmp/ddd-phase1.png npm run smoke 2>&1 | grep "^ddd:"`
Expected: all tests pass; typecheck clean; smoke prints `projects (register/list)` in its ok line and exits 0; the screenshot shows the board.

- [ ] **Step 7: Commit**

```bash
git add src/main/commands.ts src/main/commands.test.ts src/main/index.ts README.md
git commit -m "feat(main): projects, launcher and watcher commands — phase 1 complete"
```

---

## Self-review against the spec

- **§3 Emitter:** Task 1 (interface, main implementation, recording stub); Task 6 consumes it.
- **§4 phase 1 commands and event:** all nine in Task 7; `ddd://project-changed` in Task 6 with the payload the renderer's `onProjectChanged` expects.
- **§5 rows:** `projects.rs` → Tasks 2–3; `launcher.rs` → Tasks 4–5; `watcher.rs` → Task 6.
- **§6 on-disk:** `projects.json` written via `writeJson` (tmp+rename, field order id/path); `.ddd/` is only ever read.
- **§7 errors:** every message named in Global Constraints appears verbatim in Tasks 2, 4, 7.
- **§8 tests:** the Rust unit tests are ported (quoting, template splitting, script, spawn proofs, catalogs, watcher routing) plus registry/card tests on real temp repos and live watcher tests; smoke extended.
- **Deferred to phase 2:** upgrading a shallow root watch to recursive when `.ddd` appears without a registry change (same limitation as the Rust); `recapUpdatedAt` uses ISO `Z` where chrono wrote `+00:00`.
