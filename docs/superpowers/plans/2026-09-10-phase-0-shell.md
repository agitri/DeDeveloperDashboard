# Phase 0 — Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron app that boots to DDD's starter board (clock, notes, projects tab) with the shell commands — global, environments, layout, settings, keymap, events, secrets, paths — ported from Rust to TypeScript and reading the same `~/.ddd` files.

**Architecture:** One electron-vite package. `src/core` is a plain Node library (no `electron` imports, enforced by a test) holding the port of `src-tauri/src`. `src/main` hosts it: a command registry keyed by the Tauri command names, one `ipcMain.handle("ddd:invoke")`, dialogs, CSP, window. `src/preload` exposes `window.ddd.invoke/on`. `src/renderer` is DDD's frontend copied from its HEAD, with `lib/ipc.ts` rewired.

**Tech Stack:** Electron 44 (Node 24 built in), electron-vite 5, Vite 7, vitest 5, TypeScript 5.8, React 19, `node:sqlite`, `@napi-rs/keyring`.

**Spec:** `docs/superpowers/specs/2026-09-10-node-port-design.md`

## Global Constraints

- Source of truth for behaviour: `../DDD` (read-only from here) at commit `7fe0f68`. When in doubt, open the Rust file with the same name and do what it does.
- Nothing under `src/core/` may import `electron`. Nothing under `src/renderer/` may import `electron` or `node:*`.
- Command names and argument keys on the wire are the Tauri ones: snake_case command names, camelCase argument keys (`env`, `kindPrefix`, `widgetId`).
- Errors cross IPC as a bare string (the Rust `Error` serialized to its `Display` text). `io: …`, `json: …`, `sqlite: …`, `keychain: …` keep those prefixes; `config`, `notFound`, `invalid` are bare messages.
- JSON on disk is pretty-printed with two-space indent and written via `<file>.json.tmp` + rename. Object keys are emitted in the Rust struct's field order.
- `DDD_HOME` overrides `~/.ddd`. Every test that touches disk goes through `scratchEnv()` and never touches the real home.
- Do not set `"type": "module"` in `package.json` (a sandboxed preload must be CJS). Config files use the `.mts` extension so Vite loads them as ESM anyway.
- Commit after every task with the attribution trailer given in the session.
- No new frontend behaviour. The renderer diff against DDD HEAD is limited to `lib/ipc.ts`, `lib/ipc.coalesce.test.ts`, `widgets/RepoWidget.tsx` (one call), `vite-env.d.ts`.

---

## File structure

```
nodeDDD/
  package.json                     scripts, deps (no "type": "module")
  electron.vite.config.mts         main / preload / renderer builds
  vite.config.mts                  browser preview of the renderer alone (`npm run dev`)
  vitest.config.mts                node env, forks pool, src/**/*.test.ts
  tsconfig.json                    references only
  tsconfig.node.json               core + main + preload + shared
  tsconfig.web.json                renderer + shared (DOM lib)
  src/
    shared/bridge.ts               DddBridge type — the one shape preload and renderer agree on
    core/
      error.ts                     DddError with the seven kinds
      paths.ts                     dddHome, globalFile, EnvRoot, DddFolder, pathsInfo
      testing.ts                   scratchEnv() for tests
      store.ts                     readJsonOpt, readJson, writeJson
      models.ts                    type re-exports + defaultGlobal/globalFromJson/layoutFromJson
      settings.ts                  defaults, settingsFromJson, withDefaultRouting, settingsLoad/Save
      global.ts                    globalLoad (+ appearance migration), environment* commands
      keymap.ts                    keymapLoad (+ migration), keymapSave
      layout.ts                    layoutLoad/Save, layoutFileWrite/Read
      events.ts                    node:sqlite events table: log, query, clear, eventLog
      secrets.ts                   @napi-rs/keyring: set, exists, del, get (get is not a command)
      bootstrap.ts                 bootstrap(), starterLayout()
      no-electron.test.ts          contract: core never imports electron
    main/
      commands.ts                  the registry: Tauri name → core function (no electron import)
      commands.test.ts             contract: registered names exist in ../DDD's generate_handler!
      csp.ts                       CSP and DEV_CSP strings + directive() (no electron import)
      csp.test.ts                  pins the policy
      ipc.ts                       ipcMain.handle + the five host commands (dialogs, shell)
      index.ts                     app lifecycle, window, smoke mode
    preload/index.ts               window.ddd
    renderer/                      copied from ../DDD HEAD: index.html, src/**
```

---

### Task 1: Scaffold the package and the test runner

**Files:**
- Create: `package.json`, `electron.vite.config.mts`, `vite.config.mts`, `vitest.config.mts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `src/shared/bridge.ts`
- Create: `src/core/no-electron.test.ts`

**Interfaces:**
- Produces: `DddBridge` in `src/shared/bridge.ts`, consumed by preload (Task 11) and renderer (Task 12).

- [ ] **Step 1: Write package.json**

```json
{
  "name": "ddd",
  "private": true,
  "version": "0.1.0",
  "description": "DDD — De Developer Dashboard, on Node.",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "vite --config vite.config.mts",
    "dev:electron": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "preview": "electron-vite preview",
    "smoke": "electron-vite build && DDD_SMOKE=1 electron-vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.node.json && tsc -p tsconfig.web.json"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "^5.3.0",
    "@fontsource/ibm-plex-sans": "^5.3.0",
    "@napi-rs/keyring": "^2.0.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-grid-layout": "^2.2.4",
    "zustand": "^5.0.15"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^5.2.0",
    "electron": "^44.3.0",
    "electron-vite": "^5.0.0",
    "typescript": "~5.8.3",
    "vite": "^7.3.6",
    "vitest": "^5.0.0"
  }
}
```

- [ ] **Step 2: Write the three Vite configs**

`electron.vite.config.mts`:

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // externalizeDepsPlugin keeps node_modules as runtime requires, which is what
  // a native module (@napi-rs/keyring) needs.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
});
```

`vite.config.mts` (the browser preview — the renderer alone, localStorage-backed):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  server: { port: 1420, strictPort: true },
});
```

`vitest.config.mts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // DDD_HOME is process-global. One process per test file means a file can
    // point it at a scratch directory without racing another file.
    pool: "forks",
  },
});
```

- [ ] **Step 3: Write the tsconfigs**

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/core", "src/main", "src/preload", "src/shared", "*.mts"]
}
```

`tsconfig.web.json` (DDD's `tsconfig.json`, re-rooted):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/renderer", "src/shared"]
}
```

- [ ] **Step 4: Write the bridge type**

`src/shared/bridge.ts`:

```ts
/**
 * What the preload exposes as `window.ddd`, and all the renderer ever sees of
 * Electron. `invoke` mirrors Tauri's: snake_case command, camelCase args, and
 * a failure rejects with the error's message as a bare string.
 */
export interface DddBridge {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a backend event. Returns the unsubscribe. */
  on(event: string, handler: (payload: unknown) => void): () => void;
}
```

- [ ] **Step 5: Write the no-electron contract test**

`src/core/no-electron.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `core/` is the port of the Rust backend and must stay a plain Node library:
 * testable without a window, hostable by something other than Electron. The
 * only thing that keeps that true is this test.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("core stays electron-free", () => {
  it("never imports electron", () => {
    const offenders = walk(__dirname).filter((file) =>
      /(from\s+["']electron["']|require\(\s*["']electron["']\s*\))/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `npm install && npm test`
Expected: 1 test file, 1 passed. (Electron downloads its binary during install; that is normal.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json electron.vite.config.mts vite.config.mts vitest.config.mts tsconfig.json tsconfig.node.json tsconfig.web.json src/shared/bridge.ts src/core/no-electron.test.ts
git commit -m "chore: scaffold the electron-vite package and the core contract test"
```

---

### Task 2: Errors and paths

**Files:**
- Create: `src/core/error.ts`, `src/core/paths.ts`, `src/core/testing.ts`
- Test: `src/core/paths.test.ts`

**Interfaces:**
- Produces: `DddError` (`kind`, `message`), `DddError.config(msg)`, `.notFound(msg)`, `.invalid(msg)`, `.io(err)`, `.json(err)`, `.sqlite(err)`, `.keychain(err)`; `dddHome()`, `globalFile()`, `globalKeymapFile()`, `environmentsDir()`, `validateEnvId(id)`, `class EnvRoot { id; dir; static open(id) }` with the file getters listed below, `class DddFolder`, `pathsInfo(env)`, `scratchEnv(name)`.

- [ ] **Step 1: Write the failing test**

`src/core/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchEnv } from "./testing";
import { DddFolder, EnvRoot, dddHome, globalFile, globalKeymapFile, pathsInfo, validateEnvId } from "./paths";

describe("paths", () => {
  it("honours DDD_HOME", () => {
    const { home } = scratchEnv("home");
    expect(dddHome()).toBe(home);
    expect(globalFile()).toBe(join(home, "global.json"));
    expect(globalKeymapFile()).toBe(join(home, "keymap.json"));
  });

  it("opens an environment root and creates its directory", () => {
    const { home, env } = scratchEnv("root");
    expect(env.id).toBe("default");
    expect(env.dir).toBe(join(home, "environments", "default"));
    expect(existsSync(env.dir)).toBe(true);
    expect(env.settingsFile()).toBe(join(env.dir, "settings.json"));
    expect(env.layoutFile()).toBe(join(env.dir, "layout.json"));
    expect(env.keymapFile()).toBe(join(env.dir, "keymap.json"));
    expect(env.projectsFile()).toBe(join(env.dir, "projects.json"));
    expect(env.eventsDb()).toBe(join(env.dir, "events.sqlite"));
    expect(env.cacheDb()).toBe(join(env.dir, "cache.sqlite"));
    expect(env.keychainService()).toBe("ddd:default");
  });

  it("rejects ids that would not be boring directory names", () => {
    expect(() => validateEnvId("")).toThrow(/invalid environment id/);
    expect(() => validateEnvId("../x")).toThrow(/invalid environment id/);
    expect(() => validateEnvId("a".repeat(65))).toThrow(/invalid environment id/);
    expect(() => validateEnvId("work_2-b")).not.toThrow();
    expect(() => EnvRoot.open("no spaces")).toThrow(/use letters, digits, - and _ \(max 64\)/);
  });

  it("knows the .ddd contract folder", () => {
    const f = DddFolder.of("/p");
    expect(f.config()).toBe("/p/.ddd/config.json");
    expect(f.todos()).toBe("/p/.ddd/todos.json");
    expect(f.recap()).toBe("/p/.ddd/recap.md");
    expect(f.icm()).toBe("/p/.ddd/icm");
  });

  it("describes where an environment lives, for Settings → Data", () => {
    const { home, env } = scratchEnv("info");
    expect(pathsInfo(env)).toEqual({
      home,
      environmentDir: env.dir,
      settingsFile: env.settingsFile(),
      layoutFile: env.layoutFile(),
      keymapFile: env.keymapFile(),
      projectsFile: env.projectsFile(),
      eventsDb: env.eventsDb(),
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/paths.test.ts`
Expected: FAIL — cannot resolve `./testing` / `./paths`.

- [ ] **Step 3: Write error.ts**

`src/core/error.ts`:

```ts
/**
 * The one error type the core throws. Mirrors `error.rs`: the message is what
 * the Rust `Display` produced, because that text crosses IPC verbatim and the
 * settings pages show it.
 */
export type ErrorKind = "io" | "json" | "sqlite" | "keychain" | "config" | "notFound" | "invalid";

export class DddError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DddError";
  }

  static config(message: string): DddError {
    return new DddError("config", message);
  }
  static notFound(message: string): DddError {
    return new DddError("notFound", message);
  }
  /** The input was found but is not usable for what was asked. */
  static invalid(message: string): DddError {
    return new DddError("invalid", message);
  }
  static io(cause: unknown): DddError {
    return new DddError("io", `io: ${text(cause)}`);
  }
  static json(cause: unknown): DddError {
    return new DddError("json", `json: ${text(cause)}`);
  }
  static sqlite(cause: unknown): DddError {
    return new DddError("sqlite", `sqlite: ${text(cause)}`);
  }
  static keychain(cause: unknown): DddError {
    return new DddError("keychain", `keychain: ${text(cause)}`);
  }
}

function text(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Node's fs errors carry a `code`; `ENOENT` is the one callers branch on. */
export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}
```

- [ ] **Step 4: Write paths.ts**

`src/core/paths.ts`:

```ts
/**
 * Where things live on disk. Port of `paths.rs`.
 *
 * Nothing in DDD is allowed to reach for a path directly: every subsystem is
 * handed an `EnvRoot`, which is the whole of the environment isolation
 * guarantee.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DddError } from "./error";

/** `~/.ddd`, or `$DDD_HOME` when set (tests, and dev instances that must not
 *  clobber the real config). */
export function dddHome(): string {
  const custom = process.env.DDD_HOME;
  if (custom) return custom;
  const home = homedir();
  if (!home) throw DddError.config("no home directory");
  return join(home, ".ddd");
}

/** `~/.ddd/global.json` — the environment list and the last active one. */
export function globalFile(): string {
  return join(dddHome(), "global.json");
}

/** `~/.ddd/keymap.json` — one keymap for the whole app. */
export function globalKeymapFile(): string {
  return join(dddHome(), "keymap.json");
}

export function environmentsDir(): string {
  return join(dddHome(), "environments");
}

/** Environment ids become directory names and keychain namespaces, so they
 *  are kept boring on purpose. */
export function validateEnvId(id: string): void {
  const ok = id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
  if (!ok) {
    throw DddError.config(
      `invalid environment id ${JSON.stringify(id)}: use letters, digits, - and _ (max 64)`,
    );
  }
}

/** A single environment's config root. Hand this to a subsystem and it is
 *  physically unable to read another environment's data. */
export class EnvRoot {
  private constructor(
    public readonly id: string,
    public readonly dir: string,
  ) {}

  static open(id: string): EnvRoot {
    validateEnvId(id);
    const dir = join(environmentsDir(), id);
    mkdirSync(dir, { recursive: true });
    return new EnvRoot(id, dir);
  }

  settingsFile(): string { return join(this.dir, "settings.json"); }
  layoutFile(): string { return join(this.dir, "layout.json"); }
  keymapFile(): string { return join(this.dir, "keymap.json"); }
  projectsFile(): string { return join(this.dir, "projects.json"); }
  /** Which local folder is which GitHub repo. Outside the item cache, which
   *  is wiped and replaced on every sync. */
  repoLinksFile(): string { return join(this.dir, "repo-links.json"); }
  /** Your own calendar events. Same durability reason as repo-links. */
  calendarFile(): string { return join(this.dir, "calendar.json"); }
  watchlistFile(): string { return join(this.dir, "watchlist.json"); }
  /** Derived data: safe to delete, costs one request per product. */
  eolCacheFile(): string { return join(this.dir, "eol-cache.json"); }
  productsFile(): string { return join(this.dir, "products.json"); }
  productApprovalsFile(): string { return join(this.dir, "product-approvals.json"); }
  productsLogDir(): string { return join(this.dir, "products"); }
  eventsDb(): string { return join(this.dir, "events.sqlite"); }
  cacheDb(): string { return join(this.dir, "cache.sqlite"); }
  /** Keychain service name — secrets are namespaced per environment so work
   *  tokens and personal tokens can never collide. */
  keychainService(): string { return `ddd:${this.id}`; }
}

/** `<project>/.ddd` — the contract folder shared with Claude Code. */
export class DddFolder {
  constructor(public readonly dir: string) {}
  static of(project: string): DddFolder { return new DddFolder(join(project, ".ddd")); }
  config(): string { return join(this.dir, "config.json"); }
  todos(): string { return join(this.dir, "todos.json"); }
  recap(): string { return join(this.dir, "recap.md"); }
  icm(): string { return join(this.dir, "icm"); }
}

/** Settings → Data shows where an environment's files are. */
export interface PathsInfo {
  home: string;
  environmentDir: string;
  settingsFile: string;
  layoutFile: string;
  keymapFile: string;
  projectsFile: string;
  eventsDb: string;
}

export function pathsInfo(env: EnvRoot): PathsInfo {
  return {
    home: dddHome(),
    environmentDir: env.dir,
    settingsFile: env.settingsFile(),
    layoutFile: env.layoutFile(),
    keymapFile: env.keymapFile(),
    projectsFile: env.projectsFile(),
    eventsDb: env.eventsDb(),
  };
}
```

- [ ] **Step 5: Write testing.ts**

`src/core/testing.ts`:

```ts
/**
 * Test scaffolding. `DDD_HOME` is process-global; vitest runs each test file in
 * its own process (`pool: "forks"`) and the tests inside a file sequentially,
 * so pointing it at a fresh temp directory per test is safe here. Anything
 * that constructs an `EnvRoot` in a test must go through this.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvRoot } from "./paths";

export interface ScratchEnv {
  home: string;
  env: EnvRoot;
}

/** Points `DDD_HOME` at a fresh temp directory and opens the `default`
 *  environment inside it. */
export function scratchEnv(name: string): ScratchEnv {
  const home = mkdtempSync(join(tmpdir(), `ddd-test-${name}-`));
  process.env.DDD_HOME = home;
  return { home, env: EnvRoot.open("default") };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/core/paths.test.ts`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add src/core/error.ts src/core/paths.ts src/core/testing.ts src/core/paths.test.ts
git commit -m "feat(core): errors, paths and EnvRoot, ported from paths.rs"
```

---

### Task 3: The JSON store

**Files:**
- Create: `src/core/store.ts`
- Test: `src/core/store.test.ts`

**Interfaces:**
- Consumes: `DddError`, `isNotFound` from Task 2.
- Produces: `readJsonOpt(path): unknown | null`, `readJson<T>(path, fromJson: (raw: unknown) => T, fallback: () => T): T`, `writeJson(path, value): void`.

- [ ] **Step 1: Write the failing test**

`src/core/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DddError } from "./error";
import { readJson, readJsonOpt, writeJson } from "./store";

const dir = () => mkdtempSync(join(tmpdir(), "ddd-store-"));

describe("store", () => {
  it("reads null for a missing or blank file, and the value otherwise", () => {
    const d = dir();
    expect(readJsonOpt(join(d, "none.json"))).toBeNull();
    writeFileSync(join(d, "blank.json"), "  \n");
    expect(readJsonOpt(join(d, "blank.json"))).toBeNull();
    writeFileSync(join(d, "one.json"), '{"a":1}');
    expect(readJsonOpt(join(d, "one.json"))).toEqual({ a: 1 });
  });

  it("falls back for a missing file and parses an existing one", () => {
    const d = dir();
    const parse = (raw: unknown) => ({ a: (raw as { a: number }).a * 2 });
    expect(readJson(join(d, "none.json"), parse, () => ({ a: 0 }))).toEqual({ a: 0 });
    writeFileSync(join(d, "one.json"), '{"a":21}');
    expect(readJson(join(d, "one.json"), parse, () => ({ a: 0 }))).toEqual({ a: 42 });
  });

  it("reports malformed JSON as a json error", () => {
    const d = dir();
    writeFileSync(join(d, "bad.json"), "{nope");
    try {
      readJsonOpt(join(d, "bad.json"));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DddError);
      expect((e as DddError).kind).toBe("json");
      expect((e as DddError).message).toMatch(/^json: /);
    }
  });

  it("writes pretty-printed JSON through a temp file, creating parents", () => {
    const d = dir();
    const path = join(d, "deep", "er", "layout.json");
    writeJson(path, { version: 1, tabs: [] });
    expect(readFileSync(path, "utf8")).toBe('{\n  "version": 1,\n  "tabs": []\n}');
    // No staging file left behind.
    expect(readdirSync(join(d, "deep", "er"))).toEqual(["layout.json"]);
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 3: Write store.ts**

`src/core/store.ts`:

```ts
/**
 * Reading and writing the JSON files that *are* the config. Port of `store.rs`.
 *
 * Writes go through a temp file + rename so a crash mid-save can never leave a
 * half-written layout behind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DddError, isNotFound } from "./error";

/** The file's JSON value, or null when the file is missing or blank. */
export function readJsonOpt(path: string): unknown | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isNotFound(e)) return null;
    throw DddError.io(e);
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw DddError.json(e);
  }
}

/**
 * Rust's `read_json<T: Default>`: missing or blank → the default; otherwise
 * the parsed value passed through `fromJson`, which is where serde's per-field
 * defaults live on this side.
 */
export function readJson<T>(path: string, fromJson: (raw: unknown) => T, fallback: () => T): T {
  const raw = readJsonOpt(path);
  return raw === null ? fallback() : fromJson(raw);
}

/** Pretty-printed: these files are meant to be opened, diffed and shared. */
export function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const text = JSON.stringify(value, null, 2);
    // `settings.json` stages as `settings.json.tmp`, as the Rust does.
    const tmp = path.replace(/\.json$/, "") + ".json.tmp";
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    if (e instanceof DddError) throw e;
    throw DddError.io(e);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/store.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/core/store.test.ts
git commit -m "feat(core): atomic JSON store, ported from store.rs"
```

---

### Task 4: Models and settings defaults

The Rust gets per-field defaults for free from serde. Here they are explicit
`fromJson` normalizers, which also emit keys in the Rust struct order so the
files the two apps write are diffable against each other.

**Files:**
- Create: `src/core/models.ts`, `src/core/settings.ts`
- Test: `src/core/models.test.ts`, `src/core/settings.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJson` (Task 3); `EnvRoot` (Task 2).
- Produces: type re-exports `Global`, `Environment`, `Layout`, `Tab`, `TabGroup`, `Widget`, `GridPos`, `EventInput`, `EventRow`, `Settings`, `AppearanceSettings`, `Connection`; `StoredGlobal`; `defaultGlobal()`, `globalFromJson(raw)`, `defaultLayout()`, `layoutFromJson(raw)`; `defaultAppearance()`, `defaultSettings()`, `appearanceFromJson(raw)`, `settingsFromJson(raw)`, `withDefaultRouting(settings)`, `settingsLoad(env)`, `settingsSave(env, settings)`.
- Note: the renderer's `src/renderer/src/types/index.ts` does not exist until Task 12. Until then, create it from DDD so the type import resolves: `mkdir -p src/renderer/src/types && git -C ../DDD show HEAD:src/types/index.ts > src/renderer/src/types/index.ts`. Task 12 overwrites it with the identical file.

- [ ] **Step 1: Write the failing tests**

`src/core/models.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DddError } from "./error";
import { defaultGlobal, defaultLayout, globalFromJson, layoutFromJson } from "./models";

describe("global.json", () => {
  it("defaults to one Default environment with the shipped blue", () => {
    const g = defaultGlobal();
    expect(g.environments).toEqual([
      { id: "default", name: "Default", color: "#2f6ae8", hidden: false, collapsed: false },
    ]);
    expect(g.activeEnvironmentId).toBe("default");
    expect(g.appearance?.theme).toBe("system");
    // Field order is the Rust struct order, so the two apps write diffable files.
    expect(Object.keys(g)).toEqual(["version", "environments", "activeEnvironmentId", "appearance"]);
  });

  it("fills serde's defaults: version, hidden, collapsed, appearance", () => {
    const g = globalFromJson({
      environments: [{ id: "work", name: "Work", color: "#000" }],
      activeEnvironmentId: "work",
    });
    expect(g.version).toBe(1);
    expect(g.environments[0]).toEqual({ id: "work", name: "Work", color: "#000", hidden: false, collapsed: false });
    expect(g.appearance).toBeNull();
  });

  it("refuses a file missing a required field, as serde would", () => {
    expect(() => globalFromJson({ environments: [] })).toThrow(DddError);
    expect(() => globalFromJson({ environments: [] })).toThrow(/missing field `activeEnvironmentId`/);
  });
});

describe("layout.json", () => {
  it("defaults to nothing", () => {
    expect(defaultLayout()).toEqual({ version: 1, groups: [], tabs: [] });
  });

  it("fills widget and tab defaults", () => {
    const l = layoutFromJson({
      tabs: [{ id: "t", name: "T", widgets: [{ id: "w", kind: "clock", layout: { x: 0, y: 0, w: 3, h: 4 } }] }],
    });
    expect(l).toEqual({
      version: 1,
      groups: [],
      tabs: [
        {
          id: "t",
          name: "T",
          color: null,
          groupId: null,
          widgets: [
            {
              id: "w",
              kind: "clock",
              title: null,
              connectionId: null,
              filter: {},
              config: {},
              refreshSeconds: null,
              layout: { x: 0, y: 0, w: 3, h: 4 },
            },
          ],
        },
      ],
    });
  });
});
```

`src/core/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { scratchEnv } from "./testing";
import {
  appearanceFromJson,
  defaultSettings,
  settingsFromJson,
  settingsLoad,
  settingsSave,
  withDefaultRouting,
} from "./settings";

describe("settings defaults", () => {
  it("ships the routing split the README describes", () => {
    const s = defaultSettings();
    expect(s.ai.routing).toEqual({
      "code.propose_fix": "anthropic",
      "issue.tasks": "anthropic",
      "mail.classify": "local",
      "mail.draft": "anthropic",
      "thread.summarize": "local",
      "widget.instructions": "local",
    });
    expect(s.ai.anthropicModel).toBe("claude-opus-5");
    expect(s.ai.localModel).toBe("llama3.1:8b");
    expect(s.ai.ollamaUrl).toBe("http://localhost:11434");
    expect(s.data.statsLoggingEnabled).toBe(true);
    expect(s.voice.sttModel).toBe("base");
    expect(s.connections).toEqual([]);
  });

  it("fills every missing section and field, as serde(default) does", () => {
    const s = settingsFromJson({ version: 1, connections: [] });
    expect(s).toEqual(defaultSettings());
    const partial = settingsFromJson({ ai: { defaultProvider: "ollama" } });
    expect(partial.ai.defaultProvider).toBe("ollama");
    expect(partial.ai.ollamaUrl).toBe("");
    expect(partial.ai.anthropicModel).toBe("claude-opus-5");
  });

  it("reads a legacy appearance block, falling back to defaults when it is unusable", () => {
    expect(appearanceFromJson({ theme: "dark", defaultRefreshSeconds: 120 })).toEqual({
      theme: "dark",
      look: "classic",
      terminalApp: null,
      editor: null,
      launchCommand: "claude",
      defaultRefreshSeconds: 120,
      showShortcutHints: false,
    });
    expect(appearanceFromJson({ theme: "dark" }).theme).toBe("system");
    expect(appearanceFromJson(null).theme).toBe("system");
  });
});

describe("with_default_routing", () => {
  it("an action shipped after your settings file still routes local", () => {
    const stored = defaultSettings();
    stored.ai.defaultProvider = "anthropic";
    delete stored.ai.routing["widget.instructions"];
    expect(withDefaultRouting(stored).ai.routing["widget.instructions"]).toBe("local");
  });

  it("a choice the user made is never overwritten", () => {
    const stored = defaultSettings();
    stored.ai.routing["mail.classify"] = "anthropic";
    expect(withDefaultRouting(stored).ai.routing["mail.classify"]).toBe("anthropic");
  });
});

describe("settings on disk", () => {
  it("loads defaults for a fresh environment and round-trips a save", () => {
    const { env } = scratchEnv("settings");
    expect(settingsLoad(env)).toEqual(defaultSettings());
    const s = defaultSettings();
    s.ai.defaultProvider = "ollama";
    settingsSave(env, s);
    expect(settingsLoad(env).ai.defaultProvider).toBe("ollama");
    expect(readFileSync(env.settingsFile(), "utf8")).toContain('"defaultProvider": "ollama"');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/models.test.ts src/core/settings.test.ts`
Expected: FAIL — cannot resolve `./models` / `./settings`.

- [ ] **Step 3: Write models.ts**

`src/core/models.ts`:

```ts
/**
 * Data model shared by every subsystem. Port of `models.rs`.
 *
 * The shapes are the renderer's — `types/index.ts` mirrors `models.rs` field
 * for field — so they are re-exported rather than written twice. What is added
 * here is what serde did implicitly: defaults for missing fields, errors for
 * missing required ones, and the Rust field order on the way out.
 */
import { DddError } from "./error";
import type {
  AppearanceSettings,
  Environment,
  EventInput,
  EventRow,
  Global,
  GridPos,
  Layout,
  Tab,
  TabGroup,
  Widget,
} from "../renderer/src/types";

export type {
  AppearanceSettings,
  Environment,
  EventInput,
  EventRow,
  Global,
  GridPos,
  Layout,
  Tab,
  TabGroup,
  Widget,
};

/** `global.json` as it may be on disk: `appearance` is absent in files written
 *  before it became global. `globalLoad` migrates and never returns null. */
export interface StoredGlobal {
  version: number;
  environments: Environment[];
  activeEnvironmentId: string;
  appearance: AppearanceSettings | null;
}

// --- small serde stand-ins ---------------------------------------------------

export function record(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw DddError.json(`invalid type: expected ${what} object`);
  }
  return raw as Record<string, unknown>;
}

export function required<T>(obj: Record<string, unknown>, field: string, guard: (v: unknown) => v is T): T {
  const v = obj[field];
  if (v === undefined) throw DddError.json(`missing field \`${field}\``);
  if (!guard(v)) throw DddError.json(`invalid type for field \`${field}\``);
  return v;
}

export const isString = (v: unknown): v is string => typeof v === "string";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

export function optional<T>(obj: Record<string, unknown>, field: string, guard: (v: unknown) => v is T, fallback: T): T {
  const v = obj[field];
  if (v === undefined || v === null) return fallback;
  if (!guard(v)) throw DddError.json(`invalid type for field \`${field}\``);
  return v;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- environments --------------------------------------------------------------

export function environmentFromJson(raw: unknown): Environment {
  const o = record(raw, "environment");
  return {
    id: required(o, "id", isString),
    name: required(o, "name", isString),
    color: required(o, "color", isString),
    hidden: optional(o, "hidden", isBoolean, false),
    collapsed: optional(o, "collapsed", isBoolean, false),
  };
}

export function defaultGlobal(): Global {
  return {
    version: 1,
    environments: [{ id: "default", name: "Default", color: "#2f6ae8", hidden: false, collapsed: false }],
    activeEnvironmentId: "default",
    // Imported lazily to keep models free of a settings import cycle.
    appearance: defaultAppearanceForGlobal(),
  } as Global;
}

// `settings.ts` imports `models.ts` for the types; the default appearance is
// duplicated here in one place rather than importing back.
function defaultAppearanceForGlobal(): AppearanceSettings {
  return {
    theme: "system",
    look: "classic",
    terminalApp: null,
    editor: null,
    launchCommand: "claude",
    defaultRefreshSeconds: 300,
    showShortcutHints: true,
  };
}

export function globalFromJson(raw: unknown): StoredGlobal {
  const o = record(raw, "global");
  const environments = required(o, "environments", isArray).map(environmentFromJson);
  const appearance = o.appearance === undefined || o.appearance === null ? null : (o.appearance as AppearanceSettings);
  return {
    version: optional(o, "version", isNumber, 1),
    environments,
    activeEnvironmentId: required(o, "activeEnvironmentId", isString),
    appearance,
  };
}

// --- layout --------------------------------------------------------------------

export function gridPosFromJson(raw: unknown): GridPos {
  const o = record(raw, "layout");
  return {
    x: required(o, "x", isNumber),
    y: required(o, "y", isNumber),
    w: required(o, "w", isNumber),
    h: required(o, "h", isNumber),
  };
}

export function widgetFromJson(raw: unknown): Widget {
  const o = record(raw, "widget");
  return {
    id: required(o, "id", isString),
    kind: required(o, "kind", isString),
    title: optional(o, "title", isString, null as string | null),
    connectionId: optional(o, "connectionId", isString, null as string | null),
    filter: optional(o, "filter", isPlainRecord, {}),
    config: optional(o, "config", isPlainRecord, {}),
    refreshSeconds: optional(o, "refreshSeconds", isNumber, null as number | null),
    layout: gridPosFromJson(o.layout ?? (() => { throw DddError.json("missing field `layout`"); })()),
  };
}

export function tabFromJson(raw: unknown): Tab {
  const o = record(raw, "tab");
  return {
    id: required(o, "id", isString),
    name: required(o, "name", isString),
    color: optional(o, "color", isString, null as string | null),
    groupId: optional(o, "groupId", isString, null as string | null),
    widgets: optional(o, "widgets", isArray, [] as unknown[]).map(widgetFromJson),
  };
}

export function tabGroupFromJson(raw: unknown): TabGroup {
  const o = record(raw, "group");
  return {
    id: required(o, "id", isString),
    name: required(o, "name", isString),
    color: required(o, "color", isString),
    collapsed: optional(o, "collapsed", isBoolean, false),
  };
}

export function defaultLayout(): Layout {
  return { version: 1, groups: [], tabs: [] };
}

export function layoutFromJson(raw: unknown): Layout {
  const o = record(raw, "layout");
  return {
    version: optional(o, "version", isNumber, 1),
    groups: optional(o, "groups", isArray, [] as unknown[]).map(tabGroupFromJson),
    tabs: optional(o, "tabs", isArray, [] as unknown[]).map(tabFromJson),
  };
}
```

Check the renderer's `Tab` and `Widget` types accept `null` for `color`, `groupId`, `title`, `connectionId`, `refreshSeconds` (they are declared `?: string | null`). If `Global.appearance` is declared non-optional there, the `as Global` in `defaultGlobal` is what keeps `tsc` quiet; do not change the renderer type.

- [ ] **Step 4: Write settings.ts**

`src/core/settings.ts`:

```ts
/**
 * `settings.json` per environment: AI routing, voice, data, and the connection
 * records (never secrets). Port of `settings.rs`.
 */
import type { Settings, AppearanceSettings, Connection } from "../renderer/src/types";
import type { EnvRoot } from "./paths";
import { readJson, writeJson } from "./store";
import { isBoolean, isNumber, isString, optional, record } from "./models";

export type { Settings, AppearanceSettings, Connection };

export type ConnectionStatus = "disconnected" | "connected" | "expired" | "error";

export function defaultAppearance(): AppearanceSettings {
  return {
    theme: "system",
    look: "classic",
    terminalApp: null,
    editor: null,
    launchCommand: "claude",
    defaultRefreshSeconds: 300,
    showShortcutHints: true,
  };
}

export function defaultAiSettings(): Settings["ai"] {
  return {
    defaultProvider: "anthropic",
    ollamaUrl: "http://localhost:11434",
    openaiCompatibleUrl: null,
    // Cheap/private work local, drafting and code to Claude. `widget.instructions`
    // is local and pinned there by a test in the Rust; keep it so.
    routing: {
      "code.propose_fix": "anthropic",
      "issue.tasks": "anthropic",
      "mail.classify": "local",
      "mail.draft": "anthropic",
      "thread.summarize": "local",
      "widget.instructions": "local",
    },
    monthlyBudgetUsd: null,
    anthropicModel: "claude-opus-5",
    localModel: "llama3.1:8b",
    openaiModel: "",
    classifyMailLocally: false,
  };
}

export function defaultVoiceSettings(): Settings["voice"] {
  return { enabled: false, sttMode: "local", sttModel: "base", ttsEngine: "os", ttsVoice: null, microphone: null };
}

export function defaultDataSettings(): Settings["data"] {
  return { statsLoggingEnabled: true };
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    ai: defaultAiSettings(),
    voice: defaultVoiceSettings(),
    data: defaultDataSettings(),
    connections: [],
  };
}

/**
 * The Rust reads a legacy `appearance` block with `serde_json::from_value(..).ok()
 * .unwrap_or_default()`: a block missing a field without a default (`theme`,
 * `defaultRefreshSeconds`) is discarded whole, not patched.
 */
export function appearanceFromJson(raw: unknown): AppearanceSettings {
  if (typeof raw !== "object" || raw === null) return defaultAppearance();
  const o = raw as Record<string, unknown>;
  if (!isString(o.theme) || !isNumber(o.defaultRefreshSeconds)) return defaultAppearance();
  return {
    theme: o.theme,
    look: optional(o, "look", isString, "classic"),
    terminalApp: optional(o, "terminalApp", isString, null as string | null),
    editor: optional(o, "editor", isString, null as string | null),
    launchCommand: optional(o, "launchCommand", isString, "claude"),
    defaultRefreshSeconds: o.defaultRefreshSeconds,
    showShortcutHints: optional(o, "showShortcutHints", isBoolean, false),
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isString);
}

function aiFromJson(raw: unknown): Settings["ai"] {
  const d = defaultAiSettings();
  if (raw === undefined || raw === null) return d;
  const o = record(raw, "ai");
  return {
    defaultProvider: optional(o, "defaultProvider", isString, d.defaultProvider),
    ollamaUrl: optional(o, "ollamaUrl", isString, ""),
    openaiCompatibleUrl: optional(o, "openaiCompatibleUrl", isString, null as string | null),
    routing: optional(o, "routing", isStringMap, {}),
    monthlyBudgetUsd: optional(o, "monthlyBudgetUsd", isNumber, null as number | null),
    anthropicModel: optional(o, "anthropicModel", isString, d.anthropicModel),
    localModel: optional(o, "localModel", isString, d.localModel),
    openaiModel: optional(o, "openaiModel", isString, ""),
    classifyMailLocally: optional(o, "classifyMailLocally", isBoolean, false),
  };
}

function voiceFromJson(raw: unknown): Settings["voice"] {
  const d = defaultVoiceSettings();
  if (raw === undefined || raw === null) return d;
  const o = record(raw, "voice");
  return {
    enabled: optional(o, "enabled", isBoolean, d.enabled),
    sttMode: optional(o, "sttMode", isString, d.sttMode),
    sttModel: optional(o, "sttModel", isString, d.sttModel),
    ttsEngine: optional(o, "ttsEngine", isString, d.ttsEngine),
    ttsVoice: optional(o, "ttsVoice", isString, null as string | null),
    microphone: optional(o, "microphone", isString, null as string | null),
  };
}

function dataFromJson(raw: unknown): Settings["data"] {
  if (raw === undefined || raw === null) return defaultDataSettings();
  const o = record(raw, "data");
  return { statsLoggingEnabled: optional(o, "statsLoggingEnabled", isBoolean, true) };
}

function connectionFromJson(raw: unknown): Connection {
  const o = record(raw, "connection");
  return {
    id: String(o.id),
    provider: String(o.provider),
    label: String(o.label),
    status: (o.status as ConnectionStatus) ?? "disconnected",
    scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : [],
    config: isStringMap(o.config) ? o.config : {},
    lastSyncAt: optional(o, "lastSyncAt", isString, null as string | null),
    error: optional(o, "error", isString, null as string | null),
  } as Connection;
}

export function settingsFromJson(raw: unknown): Settings {
  const o = record(raw, "settings");
  return {
    version: optional(o, "version", isNumber, 1),
    ai: aiFromJson(o.ai),
    voice: voiceFromJson(o.voice),
    data: dataFromJson(o.data),
    connections: Array.isArray(o.connections) ? o.connections.map(connectionFromJson) : [],
  };
}

/**
 * Fill in routing entries this file has never heard of. A key already present
 * is never touched — an explicit choice is a choice. Nothing is written back.
 */
export function withDefaultRouting(settings: Settings): Settings {
  const routing = { ...settings.ai.routing };
  for (const [action, provider] of Object.entries(defaultAiSettings().routing)) {
    if (!(action in routing)) routing[action] = provider;
  }
  return { ...settings, ai: { ...settings.ai, routing } };
}

export function settingsLoad(env: EnvRoot): Settings {
  return withDefaultRouting(readJson(env.settingsFile(), settingsFromJson, defaultSettings));
}

export function settingsSave(env: EnvRoot, settings: Settings): void {
  writeJson(env.settingsFile(), settings);
}
```

If the renderer's `Connection` type has fields beyond these (check `src/renderer/src/types/index.ts` around `interface Connection`), map them the same way; the `as Connection` is only there for `status`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/models.test.ts src/core/settings.test.ts`
Expected: 11 passed.

- [ ] **Step 6: Typecheck the node project**

Run: `npx tsc -p tsconfig.node.json`
Expected: no output (clean). If the renderer `types/index.ts` was not yet created, run the `git show` command from the Interfaces note above first.

- [ ] **Step 7: Commit**

```bash
git add src/core/models.ts src/core/settings.ts src/core/models.test.ts src/core/settings.test.ts src/renderer/src/types/index.ts
git commit -m "feat(core): models and settings with serde-equivalent defaults"
```

---

### Task 5: global.json and environments

**Files:**
- Create: `src/core/global.ts`, `src/core/secrets.ts`
- Test: `src/core/global.test.ts`, `src/core/secrets.test.ts`

**Interfaces:**
- Consumes: `globalFile`, `EnvRoot` (Task 2); `readJson`, `readJsonOpt`, `writeJson` (Task 3); `defaultGlobal`, `globalFromJson`, `appearanceFromJson`, `settingsLoad` (Task 4).
- Produces: `globalLoad(): Global`, `globalAppearanceSave(appearance): Global`, `environmentCreate(id, name, color): Global`, `environmentUpdate(id, patch: { name?, color?, hidden?, collapsed? }): Global`, `environmentSetActive(id): Global`, `environmentDelete(id): Global`; `secrets.set(env, key, value)`, `secrets.exists(env, key): boolean`, `secrets.del(env, key)`, `secrets.get(env, key): string | null`.

- [ ] **Step 1: Write the failing tests**

`src/core/global.test.ts` (the Rust `global_appearance_tests`, plus the environment commands):

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { globalFile } from "./paths";
import { scratchEnv } from "./testing";
import {
  environmentCreate,
  environmentDelete,
  environmentSetActive,
  environmentUpdate,
  globalAppearanceSave,
  globalLoad,
} from "./global";

describe("appearance on global.json", () => {
  it("is adopted from the active environment once", () => {
    const { env } = scratchEnv("appearance-migration");
    // A settings.json as the previous version wrote it.
    writeFileSync(
      env.settingsFile(),
      JSON.stringify({
        version: 1,
        appearance: {
          theme: "dark",
          terminalApp: "iTerm",
          launchCommand: "claude --continue",
          defaultRefreshSeconds: 120,
          showShortcutHints: true,
        },
        connections: [],
      }),
    );
    // A global.json from before the field existed.
    writeFileSync(
      globalFile(),
      JSON.stringify({
        version: 1,
        environments: [{ id: "default", name: "Default", color: "#2f6ae8", hidden: false }],
        activeEnvironmentId: "default",
      }),
    );

    const g = globalLoad();
    expect(g.appearance.theme).toBe("dark");
    expect(g.appearance.terminalApp).toBe("iTerm");
    expect(g.appearance.defaultRefreshSeconds).toBe(120);

    // Written back, so it never migrates twice and the user can read it.
    const onDisk = JSON.parse(readFileSync(globalFile(), "utf8"));
    expect(onDisk.appearance.theme).toBe("dark");

    // Changing the old per-environment file now has no effect.
    writeFileSync(env.settingsFile(), JSON.stringify({ version: 1, connections: [] }));
    expect(globalLoad().appearance.theme).toBe("dark");
  });

  it("a fresh install gets defaults rather than none", () => {
    scratchEnv("appearance-fresh");
    const g = globalLoad();
    expect(g.appearance.theme).toBe("system");
    expect(existsSync(globalFile())).toBe(true);
  });

  it("saving appearance persists it globally", () => {
    scratchEnv("appearance-save");
    const appearance = { ...globalLoad().appearance, theme: "light" };
    globalAppearanceSave(appearance);
    expect(globalLoad().appearance.theme).toBe("light");
  });
});

describe("environments", () => {
  it("creates one, with its directory, and refuses a duplicate", () => {
    const { home } = scratchEnv("env-create");
    const g = environmentCreate("work", "Work", "#00a99f");
    expect(g.environments.map((e) => e.id)).toEqual(["default", "work"]);
    expect(g.environments[1]).toEqual({ id: "work", name: "Work", color: "#00a99f", hidden: false, collapsed: false });
    expect(existsSync(`${home}/environments/work`)).toBe(true);
    expect(() => environmentCreate("work", "Again", "#000")).toThrow('environment "work" already exists');
  });

  it("updates only the fields given", () => {
    scratchEnv("env-update");
    environmentCreate("work", "Work", "#00a99f");
    const g = environmentUpdate("work", { name: "Client", hidden: true });
    const work = g.environments.find((e) => e.id === "work")!;
    expect(work).toEqual({ id: "work", name: "Client", color: "#00a99f", hidden: true, collapsed: false });
    expect(() => environmentUpdate("nope", { name: "x" })).toThrow('environment "nope"');
  });

  it("switches the active one, if it exists", () => {
    scratchEnv("env-active");
    environmentCreate("work", "Work", "#00a99f");
    expect(environmentSetActive("work").activeEnvironmentId).toBe("work");
    expect(() => environmentSetActive("nope")).toThrow('environment "nope"');
  });

  it("deletes an environment and its directory, never the last one", () => {
    const { home } = scratchEnv("env-delete");
    expect(() => environmentDelete("default")).toThrow("cannot delete the last environment");
    environmentCreate("work", "Work", "#00a99f");
    environmentSetActive("work");
    const g = environmentDelete("work");
    expect(g.environments.map((e) => e.id)).toEqual(["default"]);
    expect(g.activeEnvironmentId).toBe("default");
    expect(existsSync(`${home}/environments/work`)).toBe(false);
  });
});
```

`src/core/secrets.test.ts` (touches the real OS keychain, so it only runs when asked):

```ts
import { describe, expect, it } from "vitest";
import { scratchEnv } from "./testing";
import * as secrets from "./secrets";

// The OS keychain is not a scratch directory. `DDD_VERIFY=1 npx vitest run
// src/core/secrets.test.ts` runs this against the real thing; macOS will ask
// once to allow the process.
describe.skipIf(!process.env.DDD_VERIFY)("secrets (live keychain)", () => {
  it("round-trips set / exists / delete under the ddd:<env> service", () => {
    const { env } = scratchEnv("secrets");
    const key = `test-${Date.now()}`;
    expect(secrets.exists(env, key)).toBe(false);
    secrets.set(env, key, "hunter2");
    expect(secrets.exists(env, key)).toBe(true);
    expect(secrets.get(env, key)).toBe("hunter2");
    secrets.del(env, key);
    expect(secrets.exists(env, key)).toBe(false);
    // Deleting what is not there is not an error.
    expect(() => secrets.del(env, key)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/global.test.ts src/core/secrets.test.ts`
Expected: global FAILs (cannot resolve `./global`); secrets is skipped.

- [ ] **Step 3: Write secrets.ts**

`src/core/secrets.ts`:

```ts
/**
 * Secrets live in the OS keychain, never in config files. Port of `secrets.rs`.
 *
 * The frontend can ask whether a secret *exists* and can set or delete one; it
 * can never read one back. `get` exists for adapters and is not registered as a
 * command — that asymmetry is the architectural half of "nothing leaves
 * without approval".
 *
 * `@napi-rs/keyring` binds the same Rust `keyring` crate the Tauri app uses, so
 * an entry either app writes is readable by the other.
 */
import { Entry } from "@napi-rs/keyring";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";

function entry(env: EnvRoot, key: string): Entry {
  return new Entry(env.keychainService(), key);
}

export function set(env: EnvRoot, key: string, value: string): void {
  try {
    entry(env, key).setPassword(value);
  } catch (e) {
    throw DddError.keychain(e);
  }
}

export function exists(env: EnvRoot, key: string): boolean {
  return get(env, key) !== null;
}

export function del(env: EnvRoot, key: string): void {
  try {
    // Returns false when there was nothing to delete; that is not an error.
    entry(env, key).deletePassword();
  } catch (e) {
    throw DddError.keychain(e);
  }
}

/** Read side: adapters only. Never register this as a command. */
export function get(env: EnvRoot, key: string): string | null {
  try {
    return entry(env, key).getPassword() ?? null;
  } catch (e) {
    throw DddError.keychain(e);
  }
}
```

- [ ] **Step 4: Write global.ts**

`src/core/global.ts`:

```ts
/**
 * `~/.ddd/global.json`: the environment list, the active one, and the one
 * appearance for the whole app. Port of the environment half of `commands.rs`.
 */
import { existsSync, rmSync } from "node:fs";
import { DddError } from "./error";
import { EnvRoot, globalFile } from "./paths";
import { readJson, readJsonOpt, writeJson } from "./store";
import { defaultGlobal, globalFromJson, type AppearanceSettings, type Global, type StoredGlobal } from "./models";
import { appearanceFromJson, settingsLoad } from "./settings";
import * as secrets from "./secrets";

export function globalLoad(): Global {
  const path = globalFile();
  if (!existsSync(path)) {
    const g = defaultGlobal();
    writeJson(path, g);
    return g;
  }
  const stored: StoredGlobal = readJson(path, globalFromJson, () => ({ ...defaultGlobal(), appearance: null }) as StoredGlobal);
  if (stored.appearance === null) {
    stored.appearance = migrateAppearance(stored.activeEnvironmentId);
    // Written back once so the migration never runs again, and so the adopted
    // values are visible in the file the user can read.
    writeJson(path, stored);
  }
  return stored as Global;
}

/**
 * Appearance used to live in every environment's `settings.json`. Adopt the
 * active environment's copy so the app looks the same after the upgrade as it
 * did before it, then never look again. Read as raw JSON on purpose: `Settings`
 * no longer has the field.
 */
function migrateAppearance(activeEnv: string): AppearanceSettings {
  let root: EnvRoot;
  try {
    root = EnvRoot.open(activeEnv);
  } catch {
    return appearanceFromJson(null);
  }
  let raw: unknown = null;
  try {
    raw = readJsonOpt(root.settingsFile());
  } catch {
    raw = null;
  }
  const block = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).appearance : null;
  return appearanceFromJson(block);
}

function globalSave(g: Global): void {
  writeJson(globalFile(), g);
}

/** Appearance is one setting for the whole app, so it is saved on
 *  `global.json` rather than on whichever environment happened to be in front. */
export function globalAppearanceSave(appearance: AppearanceSettings): Global {
  const g = globalLoad();
  g.appearance = appearance;
  globalSave(g);
  return g;
}

export function environmentCreate(id: string, name: string, color: string): Global {
  const g = globalLoad();
  if (g.environments.some((e) => e.id === id)) {
    throw DddError.config(`environment ${JSON.stringify(id)} already exists`);
  }
  // Creating the root before recording it means a crash leaves an unused
  // directory, not a dangling reference the UI would choke on.
  EnvRoot.open(id);
  g.environments.push({ id, name, color, hidden: false, collapsed: false });
  globalSave(g);
  return g;
}

export interface EnvironmentPatch {
  name?: string;
  color?: string;
  hidden?: boolean;
  collapsed?: boolean;
}

export function environmentUpdate(id: string, patch: EnvironmentPatch): Global {
  const g = globalLoad();
  const env = g.environments.find((e) => e.id === id);
  if (!env) throw DddError.notFound(`environment ${JSON.stringify(id)}`);
  if (patch.name !== undefined) env.name = patch.name;
  if (patch.color !== undefined) env.color = patch.color;
  if (patch.collapsed !== undefined) env.collapsed = patch.collapsed;
  // Focus mode is a visibility toggle, never a data operation.
  if (patch.hidden !== undefined) env.hidden = patch.hidden;
  globalSave(g);
  return g;
}

export function environmentSetActive(id: string): Global {
  const g = globalLoad();
  if (!g.environments.some((e) => e.id === id)) {
    throw DddError.notFound(`environment ${JSON.stringify(id)}`);
  }
  g.activeEnvironmentId = id;
  globalSave(g);
  return g;
}

/** Deleting an environment deletes *all* of its data: its directory and every
 *  keychain entry its connections own. */
export function environmentDelete(id: string): Global {
  const g = globalLoad();
  if (g.environments.length <= 1) {
    throw DddError.config("cannot delete the last environment");
  }
  const env = EnvRoot.open(id);
  try {
    for (const c of settingsLoad(env).connections) {
      try {
        secrets.del(env, c.id);
      } catch {
        // A keychain refusal must not strand the directory delete.
      }
    }
  } catch {
    // Unreadable settings: nothing to clean in the keychain.
  }
  if (existsSync(env.dir)) rmSync(env.dir, { recursive: true, force: true });
  g.environments = g.environments.filter((e) => e.id !== id);
  if (g.activeEnvironmentId === id) g.activeEnvironmentId = g.environments[0]!.id;
  globalSave(g);
  return g;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/global.test.ts src/core/secrets.test.ts`
Expected: 7 passed, 1 skipped.

- [ ] **Step 6: Run the live keychain test once**

Run: `DDD_VERIFY=1 npx vitest run src/core/secrets.test.ts`
Expected: 1 passed (macOS may show a keychain prompt; click Allow). If it fails with a load error for the native module, run `npm rebuild @napi-rs/keyring` and retry. Record the outcome in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/core/global.ts src/core/secrets.ts src/core/global.test.ts src/core/secrets.test.ts
git commit -m "feat(core): global.json, environments and keychain secrets"
```

---

### Task 6: Keymap and layout

**Files:**
- Create: `src/core/keymap.ts`, `src/core/layout.ts`
- Test: `src/core/keymap.test.ts`, `src/core/layout.test.ts`

**Interfaces:**
- Consumes: `globalLoad` (Task 5); `globalKeymapFile`, `EnvRoot` (Task 2); store (Task 3); `defaultLayout`, `layoutFromJson` (Task 4).
- Produces: `keymapLoad(): unknown | null`, `keymapSave(keymap: unknown)`, `layoutLoad(env): Layout`, `layoutSave(env, layout)`, `layoutFileWrite(path, contents)`, `layoutFileRead(path): string`.

- [ ] **Step 1: Write the failing tests**

`src/core/keymap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { globalKeymapFile } from "./paths";
import { scratchEnv } from "./testing";
import { keymapLoad, keymapSave } from "./keymap";

describe("keymap", () => {
  it("is null until someone saves one", () => {
    scratchEnv("keymap-none");
    expect(keymapLoad()).toBeNull();
  });

  it("is adopted from the active environment once", () => {
    const { env } = scratchEnv("keymap-migration");
    writeFileSync(env.keymapFile(), JSON.stringify({ "tab.new": ["mod+shift+t"] }));
    expect((keymapLoad() as Record<string, string[]>)["tab.new"]).toEqual(["mod+shift+t"]);
    // Now global; the old per-environment file is no longer consulted.
    writeFileSync(env.keymapFile(), JSON.stringify({ "tab.new": ["mod+9"] }));
    expect((keymapLoad() as Record<string, string[]>)["tab.new"]).toEqual(["mod+shift+t"]);
  });

  it("stores whatever the frontend hands it, verbatim", () => {
    scratchEnv("keymap-save");
    keymapSave({ "palette.open": ["mod+k"] });
    expect(JSON.parse(readFileSync(globalKeymapFile(), "utf8"))).toEqual({ "palette.open": ["mod+k"] });
    expect(keymapLoad()).toEqual({ "palette.open": ["mod+k"] });
  });
});
```

`src/core/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchEnv } from "./testing";
import { layoutFileRead, layoutFileWrite, layoutLoad, layoutSave } from "./layout";

describe("layout on disk", () => {
  it("is empty for a fresh environment and round-trips", () => {
    const { env } = scratchEnv("layout");
    expect(layoutLoad(env)).toEqual({ version: 1, groups: [], tabs: [] });
    layoutSave(env, { version: 1, groups: [], tabs: [{ id: "t", name: "T", color: null, groupId: null, widgets: [] }] });
    expect(layoutLoad(env).tabs[0]?.name).toBe("T");
    expect(readFileSync(env.layoutFile(), "utf8")).toContain('"name": "T"');
  });
});

describe("layout files the user picks", () => {
  it("only ever writes a .json file", () => {
    const { home } = scratchEnv("layout-write");
    expect(() => layoutFileWrite(join(home, "board.txt"), "{}")).toThrow("a layout is written as a .json file");
    layoutFileWrite(join(home, "board.json"), '{"version":1}');
    expect(readFileSync(join(home, "board.json"), "utf8")).toBe('{"version":1}');
  });

  it("only ever reads a small .json file", () => {
    const { home } = scratchEnv("layout-read");
    expect(() => layoutFileRead(join(home, "board.txt"))).toThrow("a layout is read from a .json file");
    writeFileSync(join(home, "big.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    expect(() => layoutFileRead(join(home, "big.json"))).toThrow(/a layout is kilobytes/);
    writeFileSync(join(home, "ok.json"), '{"version":1}');
    expect(layoutFileRead(join(home, "ok.json"))).toBe('{"version":1}');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/core/keymap.test.ts src/core/layout.test.ts`
Expected: FAIL — cannot resolve `./keymap` / `./layout`.

- [ ] **Step 3: Write keymap.ts**

`src/core/keymap.ts`:

```ts
/**
 * The keymap's schema belongs to the frontend action registry, so the core
 * stores it verbatim rather than pretending to understand it. One keymap for
 * the whole app: shortcuts are muscle memory.
 */
import { EnvRoot, globalKeymapFile } from "./paths";
import { readJsonOpt, writeJson } from "./store";
import { globalLoad } from "./global";

export function keymapLoad(): unknown | null {
  const path = globalKeymapFile();
  const found = readJsonOpt(path);
  if (found !== null) return found;
  // Adopt whatever the active environment had, once, so a customised keymap
  // survives the move.
  const active = globalLoad().activeEnvironmentId;
  let legacy: unknown | null = null;
  try {
    legacy = readJsonOpt(EnvRoot.open(active).keymapFile());
  } catch {
    legacy = null;
  }
  if (legacy === null) return null;
  writeJson(path, legacy);
  return legacy;
}

export function keymapSave(keymap: unknown): void {
  writeJson(globalKeymapFile(), keymap);
}
```

- [ ] **Step 4: Write layout.ts**

`src/core/layout.ts`:

```ts
/**
 * `layout.json` per environment, and the two narrow file commands behind
 * "export / import layout". The webview picks the path through a dialog and
 * hands it here; this will only ever write UTF-8 to a `.json` file.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";
import { readJson, writeJson } from "./store";
import { defaultLayout, layoutFromJson, type Layout } from "./models";

export function layoutLoad(env: EnvRoot): Layout {
  return readJson(env.layoutFile(), layoutFromJson, defaultLayout);
}

export function layoutSave(env: EnvRoot, layout: Layout): void {
  writeJson(env.layoutFile(), layout);
}

export function layoutFileWrite(path: string, contents: string): void {
  if (extname(path) !== ".json") {
    throw DddError.invalid("a layout is written as a .json file");
  }
  try {
    writeFileSync(path, contents);
  } catch (e) {
    throw DddError.io(e);
  }
}

/** Same narrowness, and a size cap: a layout is kilobytes. */
export function layoutFileRead(path: string): string {
  const MAX = 4 * 1024 * 1024;
  if (extname(path) !== ".json") {
    throw DddError.invalid("a layout is read from a .json file");
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw DddError.io(e);
  }
  if (size > MAX) {
    throw DddError.invalid(`that file is ${size} bytes — a layout is kilobytes, so this is not one`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw DddError.io(e);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/keymap.test.ts src/core/layout.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add src/core/keymap.ts src/core/layout.ts src/core/keymap.test.ts src/core/layout.test.ts
git commit -m "feat(core): keymap with migration, layout and the narrow layout-file commands"
```

---

### Task 7: The events table

**Files:**
- Create: `src/core/events.ts`
- Test: `src/core/events.test.ts`

**Interfaces:**
- Consumes: `EnvRoot` (Task 2); `settingsLoad`, `settingsSave`, `defaultSettings` (Task 4); `EventInput`, `EventRow` types (Task 4).
- Produces: `log(env, event): number`, `query(env, { since?, kindPrefix?, limit }): EventRow[]`, `clear(env)`, `eventLog(env, event)` (the command: respects the stats toggle).

- [ ] **Step 1: Write the failing test**

`src/core/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { scratchEnv } from "./testing";
import { defaultSettings, settingsSave } from "./settings";
import { clear, eventLog, log, query } from "./events";

describe("events", () => {
  it("logs rows and reads them newest first, with a null for every absent field", () => {
    const { env } = scratchEnv("events");
    const first = log(env, { kind: "tab.switch" });
    const second = log(env, { kind: "ai.mail.draft", source: "anthropic", project: "ddd", tokensIn: 10, tokensOut: 5, costMicros: 175, meta: { model: "x" } });
    expect(second).toBe(first + 1);
    expect(existsSync(env.eventsDb())).toBe(true);

    const rows = query(env, { limit: 500 });
    expect(rows.map((r) => r.kind)).toEqual(["ai.mail.draft", "tab.switch"]);
    expect(rows[1]).toEqual({ id: first, ts: rows[1]!.ts, kind: "tab.switch", source: null, project: null, tokensIn: null, tokensOut: null, costMicros: null, meta: null });
    expect(rows[0]!.meta).toEqual({ model: "x" });
    expect(rows[0]!.costMicros).toBe(175);
    expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("filters by kind prefix, lower bound and limit", () => {
    const { env } = scratchEnv("events-filter");
    log(env, { kind: "tab.switch" });
    log(env, { kind: "ai.draft" });
    log(env, { kind: "ai.summarize" });
    expect(query(env, { kindPrefix: "ai.", limit: 500 }).map((r) => r.kind)).toEqual(["ai.summarize", "ai.draft"]);
    expect(query(env, { limit: 1 }).map((r) => r.kind)).toEqual(["ai.summarize"]);
    expect(query(env, { since: "2999-01-01T00:00:00Z", limit: 500 })).toEqual([]);
    expect(query(env, { since: "2000-01-01T00:00:00Z", limit: 500 })).toHaveLength(3);
  });

  it("clears the table", () => {
    const { env } = scratchEnv("events-clear");
    log(env, { kind: "tab.switch" });
    clear(env);
    expect(query(env, { limit: 500 })).toEqual([]);
  });

  it("the command respects the stats opt-out", () => {
    const { env } = scratchEnv("events-optout");
    eventLog(env, { kind: "tab.switch" });
    expect(query(env, { limit: 500 })).toHaveLength(1);
    const s = defaultSettings();
    s.data.statsLoggingEnabled = false;
    settingsSave(env, s);
    eventLog(env, { kind: "tab.switch" });
    expect(query(env, { limit: 500 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/events.test.ts`
Expected: FAIL — cannot resolve `./events`.

- [ ] **Step 3: Write events.ts**

`src/core/events.ts`:

```ts
/**
 * The local events table. Port of `events.rs`. One database per environment;
 * nothing here ever leaves the machine.
 *
 * `node:sqlite` is built into the Node that Electron 44 bundles, so there is no
 * native module to rebuild. Same DDL as the Rust, so both apps share the file.
 */
import { DatabaseSync } from "node:sqlite";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";
import type { EventInput, EventRow } from "./models";
import { settingsLoad } from "./settings";

const DDL = `
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     ts          TEXT    NOT NULL,
     kind        TEXT    NOT NULL,
     source      TEXT,
     project     TEXT,
     tokens_in   INTEGER,
     tokens_out  INTEGER,
     cost_micros INTEGER,
     meta        TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts   ON events(ts);
  CREATE INDEX IF NOT EXISTS events_kind ON events(kind);`;

function withDb<T>(env: EnvRoot, body: (db: DatabaseSync) => T): T {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(env.eventsDb());
    db.exec(DDL);
  } catch (e) {
    throw DddError.sqlite(e);
  }
  try {
    return body(db);
  } catch (e) {
    throw e instanceof DddError ? e : DddError.sqlite(e);
  } finally {
    db.close();
  }
}

const orNull = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

export function log(env: EnvRoot, event: EventInput): number {
  return withDb(env, (db) => {
    const ts = new Date().toISOString();
    const meta = event.meta === undefined || event.meta === null ? null : JSON.stringify(event.meta);
    const result = db
      .prepare(
        `INSERT INTO events (ts, kind, source, project, tokens_in, tokens_out, cost_micros, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ts, event.kind, orNull(event.source), orNull(event.project), orNull(event.tokensIn), orNull(event.tokensOut), orNull(event.costMicros), meta);
    return Number(result.lastInsertRowid);
  });
}

export interface EventsQuery {
  /** RFC 3339 lower bound. */
  since?: string | null;
  /** Dotted namespace prefix (`ai.`, `tab.`) the stats widget wants. */
  kindPrefix?: string | null;
  limit: number;
}

interface Row {
  id: number;
  ts: string;
  kind: string;
  source: string | null;
  project: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micros: number | null;
  meta: string | null;
}

/** Most recent first. */
export function query(env: EnvRoot, q: EventsQuery): EventRow[] {
  return withDb(env, (db) => {
    const rows = db
      .prepare(
        `SELECT id, ts, kind, source, project, tokens_in, tokens_out, cost_micros, meta
           FROM events
          WHERE ($since IS NULL OR ts >= $since)
            AND ($prefix IS NULL OR kind LIKE $prefix || '%')
          ORDER BY id DESC
          LIMIT $limit`,
      )
      .all({ since: orNull(q.since), prefix: orNull(q.kindPrefix), limit: q.limit }) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      source: r.source,
      project: r.project,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      costMicros: r.cost_micros,
      meta: parseMeta(r.meta),
    }));
  });
}

function parseMeta(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** "Wipe local data" in Settings → Data. */
export function clear(env: EnvRoot): void {
  withDb(env, (db) => {
    db.prepare("DELETE FROM events").run();
  });
}

/** The `event_log` command. Opting out of stats has to actually stop the
 *  writing, not just the charts. */
export function eventLog(env: EnvRoot, event: EventInput): void {
  let enabled = true;
  try {
    enabled = settingsLoad(env).data.statsLoggingEnabled;
  } catch {
    enabled = true;
  }
  if (enabled) log(env, event);
}
```

If `EventRow`'s `meta` in the renderer type is declared `unknown`, the `null` assignment is fine. Node prints one `ExperimentalWarning` for `node:sqlite` on first use; that is expected and not an error.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/events.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/events.ts src/core/events.test.ts
git commit -m "feat(core): the events table on node:sqlite, ported from events.rs"
```

---

### Task 8: Bootstrap and the starter board

**Files:**
- Create: `src/core/bootstrap.ts`
- Test: `src/core/bootstrap.test.ts`

**Interfaces:**
- Consumes: `globalLoad` (Task 5); `EnvRoot` (Task 2); `writeJson` (Task 3); `defaultSettings` (Task 4); `Layout`, `Widget` types.
- Produces: `bootstrap(): void`, `starterLayout(): Layout`.

- [ ] **Step 1: Write the failing test**

`src/core/bootstrap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalFile } from "./paths";
import { scratchEnv } from "./testing";
import { layoutLoad } from "./layout";
import { bootstrap, starterLayout } from "./bootstrap";

describe("first run", () => {
  it("creates global.json, the default environment, and a starter board", () => {
    const { home, env } = scratchEnv("bootstrap");
    bootstrap();
    expect(existsSync(globalFile())).toBe(true);
    expect(existsSync(join(home, "environments", "default", "settings.json"))).toBe(true);
    const layout = layoutLoad(env);
    expect(layout.tabs.map((t) => t.id)).toEqual(["tab-board", "tab-projects"]);
    expect(layout.tabs[0]!.widgets.map((w) => w.kind)).toEqual(["clock", "notes"]);
    expect(layout.tabs[1]!.widgets.map((w) => w.kind)).toEqual(["projects"]);
  });

  it("never overwrites a board that already exists", () => {
    const { env } = scratchEnv("bootstrap-twice");
    bootstrap();
    const mine = { ...starterLayout(), tabs: [] };
    // Write it the way the app would, then boot again.
    const { writeJson } = require("./store") as typeof import("./store");
    writeJson(env.layoutFile(), mine);
    bootstrap();
    expect(JSON.parse(readFileSync(env.layoutFile(), "utf8")).tabs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/bootstrap.test.ts`
Expected: FAIL — cannot resolve `./bootstrap`.

- [ ] **Step 3: Write bootstrap.ts**

`src/core/bootstrap.ts`:

```ts
/**
 * First run: make sure `~/.ddd/global.json` and the default environment exist,
 * and drop a starter board in so the app never opens on an empty void. Port of
 * `bootstrap` and `starter_layout` in `lib.rs`.
 */
import { existsSync } from "node:fs";
import { EnvRoot } from "./paths";
import { writeJson } from "./store";
import { globalLoad } from "./global";
import { defaultSettings } from "./settings";
import type { Layout, Widget } from "./models";

export function bootstrap(): void {
  const global = globalLoad();
  for (const env of global.environments) {
    const root = EnvRoot.open(env.id);
    if (!existsSync(root.settingsFile())) writeJson(root.settingsFile(), defaultSettings());
    if (!existsSync(root.layoutFile())) writeJson(root.layoutFile(), starterLayout());
  }
}

/** Two widgets with no integrations behind them, which is exactly the point:
 *  if the clock and the notepad work, the widget contract works. */
export function starterLayout(): Layout {
  const widget = (id: string, kind: string, x: number, y: number, w: number, h: number): Widget => ({
    id,
    kind,
    title: null,
    connectionId: null,
    filter: {},
    config: {},
    refreshSeconds: null,
    layout: { x, y, w, h },
  });
  return {
    version: 1,
    groups: [],
    tabs: [
      {
        id: "tab-board",
        name: "Board",
        color: "#2f6ae8",
        groupId: null,
        widgets: [widget("w-clock", "clock", 0, 0, 3, 4), widget("w-notes", "notes", 3, 0, 5, 8)],
      },
      {
        id: "tab-projects",
        name: "Projects",
        color: "#00a99f",
        groupId: null,
        widgets: [widget("w-projects", "projects", 0, 0, 8, 10)],
      },
    ],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/bootstrap.test.ts`
Expected: 2 passed. If `require` is unavailable in the second test under ESM, replace that line with a static `import { writeJson } from "./store";` at the top.

- [ ] **Step 5: Run the whole core suite and typecheck**

Run: `npm test && npx tsc -p tsconfig.node.json`
Expected: all test files pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/bootstrap.ts src/core/bootstrap.test.ts
git commit -m "feat(core): bootstrap and the starter board"
```

---

### Task 9: The command registry

**Files:**
- Create: `src/main/commands.ts`
- Test: `src/main/commands.test.ts`

**Interfaces:**
- Consumes: everything in core.
- Produces: `type Handler = (args: Record<string, any>) => unknown`, `commands: Record<string, Handler>`, `HOST_COMMANDS: readonly string[]` (the five names main adds in Task 10).

- [ ] **Step 1: Write the failing test**

`src/main/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scratchEnv } from "../core/testing";
import { HOST_COMMANDS, commands } from "./commands";

const TAURI_LIB = resolve(__dirname, "../../../DDD/src-tauri/src/lib.rs");

/** The names Tauri registers, read from the source of truth when it is around. */
function tauriHandlers(): string[] | null {
  if (!existsSync(TAURI_LIB)) return null;
  const src = readFileSync(TAURI_LIB, "utf8");
  const block = src.slice(src.indexOf("generate_handler![") + "generate_handler![".length);
  const body = block.slice(0, block.indexOf("]"));
  return [...body.matchAll(/commands::(\w+)/g)].map((m) => m[1]!);
}

describe("the command registry", () => {
  it.skipIf(tauriHandlers() === null)("only registers names the Tauri app has, so the frontend contract holds", () => {
    const known = new Set(tauriHandlers()!);
    const invented = Object.keys(commands).filter((name) => !known.has(name) && !HOST_COMMANDS.includes(name));
    expect(invented).toEqual([]);
  });

  it("has every phase-0 command", () => {
    for (const name of [
      "global_load", "global_appearance_save",
      "environment_create", "environment_update", "environment_set_active", "environment_delete",
      "layout_load", "layout_save", "layout_file_write", "layout_file_read",
      "settings_load", "settings_save", "keymap_load", "keymap_save",
      "event_log", "events_query", "events_clear",
      "secret_set", "secret_exists", "secret_delete",
      "paths_info", "path_exists",
    ]) {
      expect(commands[name], name).toBeTypeOf("function");
    }
  });

  it("dispatches with the Tauri argument keys", async () => {
    const { home } = scratchEnv("registry");
    const g = (await commands.global_load!({})) as { activeEnvironmentId: string };
    expect(g.activeEnvironmentId).toBe("default");
    await commands.environment_create!({ id: "work", name: "Work", color: "#000" });
    await commands.layout_save!({ env: "work", layout: { version: 1, groups: [], tabs: [] } });
    expect(await commands.path_exists!({ path: `${home}/environments/work/layout.json` })).toBe(true);
    await commands.event_log!({ env: "work", event: { kind: "tab.switch" } });
    const rows = (await commands.events_query!({ env: "work", kindPrefix: "tab." })) as unknown[];
    expect(rows).toHaveLength(1);
    const info = (await commands.paths_info!({ env: "work" })) as { environmentDir: string };
    expect(info.environmentDir).toBe(`${home}/environments/work`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 3: Write commands.ts**

`src/main/commands.ts`:

```ts
/**
 * The IPC surface, keyed by the Tauri command names so `lib/ipc.ts` needs no
 * renaming. Deliberately dumb, like `commands.rs`: resolve an `EnvRoot`, hand
 * off to core, return. No `electron` import here — the registry is testable
 * as a plain map, and `ipc.ts` is what wires it to a window.
 */
import { existsSync } from "node:fs";
import { EnvRoot, pathsInfo } from "../core/paths";
import {
  environmentCreate,
  environmentDelete,
  environmentSetActive,
  environmentUpdate,
  globalAppearanceSave,
  globalLoad,
} from "../core/global";
import { layoutFileRead, layoutFileWrite, layoutLoad, layoutSave } from "../core/layout";
import { settingsLoad, settingsSave } from "../core/settings";
import { keymapLoad, keymapSave } from "../core/keymap";
import * as events from "../core/events";
import * as secrets from "../core/secrets";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (args: Record<string, any>) => unknown;

/** Commands the host adds on top of the Tauri set (dialogs and the shell,
 *  which were Tauri plugins). Kept here so the contract test knows them. */
export const HOST_COMMANDS = [
  "dialog_save",
  "dialog_open_file",
  "dialog_pick_directory",
  "open_external",
  "reveal_path",
] as const;

const root = (env: string) => EnvRoot.open(env);

export const commands: Record<string, Handler> = {
  // --- environments ---
  global_load: () => globalLoad(),
  global_appearance_save: ({ appearance }) => globalAppearanceSave(appearance),
  environment_create: ({ id, name, color }) => environmentCreate(id, name, color),
  environment_update: ({ id, name, color, hidden, collapsed }) =>
    environmentUpdate(id, { name, color, hidden, collapsed }),
  environment_set_active: ({ id }) => environmentSetActive(id),
  environment_delete: ({ id }) => environmentDelete(id),

  // --- layout, settings, keymap ---
  layout_load: ({ env }) => layoutLoad(root(env)),
  layout_save: ({ env, layout }) => layoutSave(root(env), layout),
  layout_file_write: ({ path, contents }) => layoutFileWrite(path, contents),
  layout_file_read: ({ path }) => layoutFileRead(path),
  settings_load: ({ env }) => settingsLoad(root(env)),
  settings_save: ({ env, settings }) => settingsSave(root(env), settings),
  keymap_load: () => keymapLoad(),
  keymap_save: ({ keymap }) => keymapSave(keymap),

  // --- events ---
  event_log: ({ env, event }) => events.eventLog(root(env), event),
  events_query: ({ env, since, kindPrefix, limit }) =>
    events.query(root(env), { since, kindPrefix, limit: limit ?? 500 }),
  events_clear: ({ env }) => events.clear(root(env)),

  // --- secrets: set, status, delete. Never get. ---
  secret_set: ({ env, key, value }) => secrets.set(root(env), key, value),
  secret_exists: ({ env, key }) => secrets.exists(root(env), key),
  secret_delete: ({ env, key }) => secrets.del(root(env), key),

  // --- paths ---
  paths_info: ({ env }) => pathsInfo(root(env)),
  path_exists: ({ path }) => existsSync(path),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/commands.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(main): the command registry, keyed by the Tauri names"
```

---

### Task 10: CSP, IPC wiring, host commands and the window

**Files:**
- Create: `src/main/csp.ts`, `src/main/csp.test.ts`, `src/main/ipc.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `commands`, `HOST_COMMANDS`, `Handler` (Task 9); `bootstrap` (Task 8).
- Produces: `CSP`, `DEV_CSP`, `directive(policy, name)`; `registerIpc()`; the `ddd:invoke` channel whose reply is `{ ok: true, value } | { ok: false, error: string }`.

- [ ] **Step 1: Write the failing CSP test**

`src/main/csp.test.ts` (the `csp` test module in `lib.rs`, ported):

```ts
import { describe, expect, it } from "vitest";
import { CSP, DEV_CSP, directive } from "./csp";

/**
 * This app holds keychain credentials and can spawn processes. It must not
 * also be able to load a remote script. Every outbound request is made by the
 * main process, so the renderer has no legitimate reason to reach the network.
 */
describe("the renderer's content policy", () => {
  it("lets the page talk to nothing but itself", () => {
    expect(directive(CSP, "connect-src")).toBe("'self'");
  });

  it("runs no remote and no inline script", () => {
    expect(directive(CSP, "script-src")).toBe("'self'");
  });

  it("embeds nothing", () => {
    expect(directive(CSP, "object-src")).toBe("'none'");
    expect(directive(CSP, "frame-src")).toBe("'none'");
    expect(directive(CSP, "frame-ancestors")).toBe("'none'");
    expect(directive(CSP, "form-action")).toBe("'none'");
  });

  it("names no host and no wildcard anywhere", () => {
    expect(CSP).not.toMatch(/https?:\/\//);
    expect(CSP).not.toMatch(/\*/);
  });

  it("in development adds only what Vite's dev server needs", () => {
    expect(directive(DEV_CSP, "connect-src")).toBe("'self' ws://localhost:5173 http://localhost:5173");
    expect(directive(DEV_CSP, "script-src")).toBe("'self' 'unsafe-inline'");
    expect(directive(DEV_CSP, "object-src")).toBe("'none'");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/csp.test.ts`
Expected: FAIL — cannot resolve `./csp`.

- [ ] **Step 3: Write csp.ts**

`src/main/csp.ts`:

```ts
/**
 * The webview's content policy, pinned. These are `tauri.conf.json`'s `csp`
 * and `devCsp` with the Tauri-only `ipc:` / `http://ipc.localhost` sources
 * removed — Electron's bridge is `contextBridge`, not a URL.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** electron-vite's dev server: a websocket for HMR and React's inline refresh preamble. */
export const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:5173 http://localhost:5173",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The value of one directive, or null when the policy does not set it. */
export function directive(policy: string, name: string): string | null {
  for (const part of policy.split(";")) {
    const [key, ...rest] = part.trim().split(/\s+/);
    if (key === name) return rest.join(" ");
  }
  return null;
}
```

- [ ] **Step 4: Run the CSP test to verify it passes**

Run: `npx vitest run src/main/csp.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Write ipc.ts**

`src/main/ipc.ts`:

```ts
/**
 * One channel, `ddd:invoke`, dispatching into the registry. The reply is an
 * envelope rather than a thrown error because Electron prefixes rejected
 * `handle` errors with "Error invoking remote method…", and the frontend
 * expects the Rust error's bare message.
 */
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { DddError } from "../core/error";
import { commands, type Handler } from "./commands";

type HostHandler = (args: Record<string, any>, event: IpcMainInvokeEvent) => unknown;

const LAYOUT_FILTER = [{ name: "DDD layout", extensions: ["json"] }];

const owner = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender) ?? undefined;

/** The commands that were Tauri plugins: dialogs pick paths, the shell opens things. */
const host: Record<string, HostHandler> = {
  async dialog_save({ suggestedName }, event) {
    const r = await dialog.showSaveDialog(owner(event)!, { defaultPath: suggestedName, filters: LAYOUT_FILTER });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  async dialog_open_file(_args, event) {
    const r = await dialog.showOpenDialog(owner(event)!, { properties: ["openFile"], filters: LAYOUT_FILTER });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async dialog_pick_directory(_args, event) {
    const r = await dialog.showOpenDialog(owner(event)!, { properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async open_external({ url }) {
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw DddError.invalid(`not a URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw DddError.invalid(`refusing to open a ${parsed.protocol} URL`);
    }
    await shell.openExternal(parsed.toString());
  },
  /** Show a folder in the OS file manager. A directory on disk, never a URL. */
  reveal_path({ path }) {
    shell.showItemInFolder(String(path));
  },
};

export function registerIpc(): void {
  ipcMain.handle("ddd:invoke", async (event, cmd: unknown, args: unknown) => {
    const name = String(cmd);
    const handler: HostHandler | Handler | undefined = host[name] ?? commands[name];
    if (!handler) return { ok: false, error: `unknown command ${name}` };
    try {
      const value = await (handler as HostHandler)((args as Record<string, any>) ?? {}, event);
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
```

- [ ] **Step 6: Write index.ts**

`src/main/index.ts`:

```ts
import { app, BrowserWindow, session } from "electron";
import { join } from "node:path";
import { bootstrap } from "../core/bootstrap";
import { CSP, DEV_CSP } from "./csp";
import { registerIpc } from "./ipc";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [DEV_URL ? DEV_CSP : CSP],
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "DDD — De Developer Dashboard",
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    // Tauri's `Overlay` + `hiddenTitle`: on macOS the traffic lights sit over
    // the page and the stylesheet leaves them a lane (`data-platform="mac"`).
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

/** `DDD_SMOKE=1`: prove preload, bridge and core meet, then quit. */
function smoke(win: BrowserWindow): void {
  win.webContents.once("did-finish-load", async () => {
    try {
      const g = (await win.webContents.executeJavaScript('window.ddd.invoke("global_load")')) as {
        environments: unknown[];
      };
      console.log(`ddd: smoke ok — ${g.environments.length} environment(s)`);
      app.exit(0);
    } catch (e) {
      console.error("ddd: smoke failed:", e);
      app.exit(1);
    }
  });
}

app.whenReady().then(() => {
  try {
    bootstrap();
  } catch (e) {
    console.error(`ddd: bootstrap failed: ${e instanceof Error ? e.message : e}`);
  }
  installCsp();
  registerIpc();
  const win = createWindow();
  if (process.env.DDD_SMOKE) smoke(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.node.json`
Expected: clean. (`electron`'s types come with the package.)

- [ ] **Step 8: Commit**

```bash
git add src/main/csp.ts src/main/csp.test.ts src/main/ipc.ts src/main/index.ts
git commit -m "feat(main): CSP, the ddd:invoke channel, host commands and the window"
```

---

### Task 11: The preload bridge

**Files:**
- Create: `src/preload/index.ts`

**Interfaces:**
- Consumes: `DddBridge` (Task 1); the `ddd:invoke` envelope (Task 10).
- Produces: `window.ddd` in the renderer.

- [ ] **Step 1: Write preload/index.ts**

`src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DddBridge } from "../shared/bridge";

type Envelope = { ok: true; value: unknown } | { ok: false; error: string };

const bridge: DddBridge = {
  async invoke(cmd, args) {
    const reply = (await ipcRenderer.invoke("ddd:invoke", cmd, args ?? {})) as Envelope;
    if (reply.ok) return reply.value as never;
    // Tauri rejected with the error's text as a bare string; so does this.
    throw reply.error;
  },
  on(event, handler) {
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.off(event, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("ddd", bridge);
```

- [ ] **Step 2: Build main and preload to prove they bundle**

Run: `npx electron-vite build 2>&1 | tail -20`
Expected: it fails only at the renderer step ("src/renderer/index.html" not found) — main and preload built to `out/main/index.js` and `out/preload/index.js`. If main or preload fail, fix before moving on.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): window.ddd — invoke with bare-string errors, and on()"
```

---

### Task 12: Bring the frontend over and rewire ipc.ts

**Files:**
- Create: `src/renderer/**` (copied from `../DDD` HEAD: `index.html`, `src/**`)
- Modify: `src/renderer/src/lib/ipc.ts`, `src/renderer/src/lib/ipc.coalesce.test.ts`, `src/renderer/src/widgets/RepoWidget.tsx`, `src/renderer/src/vite-env.d.ts`

**Interfaces:**
- Consumes: `window.ddd` (Task 11), host command names (Task 10).

- [ ] **Step 1: Copy the frontend from DDD's HEAD**

```bash
mkdir -p src/renderer
git -C ../DDD archive HEAD index.html src | tar -x -C src/renderer
ls src/renderer                      # index.html  src
git -C ../DDD rev-parse HEAD         # record this in the commit message
```

- [ ] **Step 2: Declare window.ddd for the renderer**

Replace `src/renderer/src/vite-env.d.ts` with:

```ts
/// <reference types="vite/client" />

interface Window {
  /** Present only inside the Electron window. See src/shared/bridge.ts. */
  ddd?: import("../../shared/bridge").DddBridge;
}
```

- [ ] **Step 3: Rewire ipc.ts — the native check and `call`**

In `src/renderer/src/lib/ipc.ts`, replace the block

```ts
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}
```

with

```ts
// The preload puts `window.ddd` there inside the Electron window and nowhere
// else, which is what makes the browser preview a different code path.
const bridge = typeof window !== "undefined" ? window.ddd : undefined;
const isNative = bridge !== undefined;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!bridge) throw new Error(`${cmd} needs the desktop app`);
  return bridge.invoke<T>(cmd, args);
}
```

then rename every remaining use of the old flag:

```bash
sed -i '' 's/\binTauri\b/isNative/g' src/renderer/src/lib/ipc.ts
grep -c "isNative" src/renderer/src/lib/ipc.ts    # expect ~74
grep -n "__TAURI" src/renderer/src/lib/ipc.ts      # expect nothing
```

- [ ] **Step 4: Rewire the three event subscriptions**

Each of `onProjectChanged`, `onItemsChanged`, `onRepoProgress` has the shape

```ts
    if (!isNative) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<...>("ddd://project-changed", (event) => handler(event.payload));
```

Rewrite each to (keeping its own event name and payload type):

```ts
    if (!bridge) return () => {};
    return bridge.on("ddd://project-changed", (payload) =>
      handler(payload as { environmentId: string; projectId: string }),
    );
```

For `onItemsChanged` the payload type is `{ environmentId: string }`; for `onRepoProgress` it is the `p` parameter's type already written in the handler signature.

- [ ] **Step 5: Rewire the opener and dialog calls**

`openExternal`:

```ts
  async openExternal(url: string): Promise<void> {
    if (!isNative) {
      window.open(url, "_blank", "noopener");
      return;
    }
    await call("open_external", { url });
  },
```

`revealPath`:

```ts
  async revealPath(path: string): Promise<void> {
    if (!isNative) return;
    await call("reveal_path", { path });
  },
```

`saveTextFile` — replace from `const { save } = await import(...)` to the end of the function body with:

```ts
    const path = await call<string | null>("dialog_save", { suggestedName });
    if (!path) return null;
    // Main writes it. The webview picks the path and never touches the disk —
    // the same reason connect-src is what it is.
    await call("layout_file_write", { path, contents });
    return path;
```

`openTextFile` — replace from `const { open } = await import(...)` to the end with:

```ts
    const picked = await call<string | null>("dialog_open_file");
    if (!picked) return null;
    return call("layout_file_read", { path: picked });
```

`pickDirectory`:

```ts
  async pickDirectory(): Promise<string | null> {
    if (!isNative) return null;
    return call<string | null>("dialog_pick_directory");
  },
```

Then confirm nothing Tauri is left:

```bash
grep -n "@tauri-apps" src/renderer/src/lib/ipc.ts    # expect nothing
```

- [ ] **Step 6: Fix the one widget that imported the opener directly**

In `src/renderer/src/widgets/RepoWidget.tsx`, find the line

```ts
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
```

Read the surrounding function: it calls `revealItemInDir(<path>)`. Replace the import line and that call with `await ipc.revealPath(<path>)`, adding `import { ipc } from "../lib/ipc";` at the top if the file does not already import it. Then:

```bash
grep -rn "@tauri-apps\|__TAURI" src/renderer/src | grep -v "ipc.coalesce.test.ts"   # expect nothing
```

- [ ] **Step 7: Rewrite the coalescing test's stand-in**

In `src/renderer/src/lib/ipc.coalesce.test.ts`, replace the block from `const calls` through `const { ipc } = await import("./ipc");` with:

```ts
/**
 * `window.ddd` is what the preload provides; standing one up here exercises the
 * actual path a widget takes rather than a mock of `call`.
 */
const calls: Array<{ cmd: string; args: any }> = [];
const waiting: Array<(v: unknown) => void> = [];

(globalThis as any).window = globalThis;
(globalThis as any).ddd = {
  invoke: (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return new Promise((resolve) => waiting.push(resolve));
  },
  on: () => () => {},
};

const { ipc } = await import("./ipc");
```

Update the file's opening doc comment to say `window.ddd` instead of Tauri's internals. Leave every `it(...)` unchanged.

- [ ] **Step 8: Run the whole suite and both typechecks**

Run: `npm test && npm run typecheck`
Expected: every renderer test that passed in DDD passes here (run `cd ../DDD && npx vitest run 2>&1 | tail -3` to see the count you are matching), plus the core and main tests; both `tsc` projects clean. Fix any type error the rewiring introduced before continuing — do not touch renderer files other than the four named above.

- [ ] **Step 9: Browser preview still works**

Run: `npm run dev` and open http://localhost:1420 — the board renders from localStorage with the clock and notes widgets. Stop the server.

- [ ] **Step 10: Commit**

```bash
git add src/renderer
git commit -m "feat(renderer): DDD's frontend from <DDD HEAD sha>, wired to window.ddd instead of Tauri"
```

---

### Task 13: Boot the desktop app and record what is verified

**Files:**
- Create: `README.md`
- Modify: `.gitignore` (add `out/` if missing)

- [ ] **Step 1: Smoke-test the built app against a scratch home**

```bash
export DDD_HOME=$(mktemp -d /tmp/ddd-smoke-XXXX)
npm run smoke 2>&1 | tail -5
```

Expected: the last lines include `ddd: smoke ok — 1 environment(s)` and the process exits 0. Then:

```bash
ls $DDD_HOME $DDD_HOME/environments/default
```

Expected: `global.json`, `environments/`, and inside default: `layout.json`, `settings.json`. Compare the layout the Node app wrote with what the Rust wrote for the same starter board, if a Rust-written `~/.ddd/environments/default/layout.json` exists: `diff <(jq -S . ~/.ddd/environments/default/layout.json) <(jq -S . $DDD_HOME/environments/default/layout.json)` should differ only in what the user changed on their board.

- [ ] **Step 2: Run the dev app and look at it**

```bash
DDD_HOME=$DDD_HOME npm run dev:electron
```

Expected: a window opens on the Board tab with the clock and notes widgets; the Projects tab is there; ⌘K opens the palette; Settings → Data shows the scratch paths. Close the window. If the page is blank, open DevTools (`win.webContents.openDevTools()` temporarily in `createWindow`) and read the console; a CSP violation or a `window.ddd is undefined` are the two likely causes.

- [ ] **Step 3: Write the README**

`README.md`:

```markdown
# DDD on Node

De Developer Dashboard — the [Rust/Tauri app](../DDD) rebuilt on Electron with a
TypeScript backend. Same `~/.ddd` files, same keychain entries; the two apps can
share a home.

Design: `docs/superpowers/specs/2026-09-10-node-port-design.md`.

## Run

    npm install
    npm run dev:electron     # the desktop app, with HMR
    npm run dev              # browser preview of the renderer alone, localStorage-backed
    npm test                 # vitest: core, main and renderer
    npm run smoke            # build, boot, call global_load through the bridge, exit
    npm run build            # typecheck + electron-vite build → out/

Set `DDD_HOME` to keep a dev instance away from your real board.

## Where things are

    src/core      the port of src-tauri/src — plain Node, never imports electron
    src/main      Electron host: window, ddd:invoke, dialogs, CSP
    src/preload   window.ddd
    src/renderer  the DDD frontend, copied from its HEAD; only lib/ipc.ts knows

## What is ported

| Phase | Contents | State |
|---|---|---|
| 0 | global.json, environments, layout, settings, keymap, events, secrets, paths; the app boots to the starter board | **done** |
| 1 | projects, launcher, `.ddd/` watching | |
| 2 | sync engine, GitHub, the approval gate | |
| 3 | AI providers, ICM, widget instructions | |
| 4 | calendar, repos, dev servers, EOL | |
| 5 | Jira, Slack, Gmail, IMAP, MCP | |
| 6 | products, packaging, claude-code scripts | |

The first keychain access on macOS prompts to allow the Electron binary; in a
packaged build that will be DDD itself.
```

- [ ] **Step 4: Final full run**

Run: `npm test && npm run typecheck && git status --short`
Expected: all green; only `README.md` and possibly `.gitignore` uncommitted.

- [ ] **Step 5: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: README for the Node port, phase 0 verified end to end"
```

---

## Self-review against the spec

- **§3 architecture / §3.1 host / §3.2 bridge:** Tasks 1, 9, 10, 11. The `Emitter` interface (§3) is not needed until an event exists in phase 1 and is deliberately deferred.
- **§3.3 frontend changes:** Task 12, all five listed diffs; the `@tauri-apps/*` packages are absent from Task 1's `package.json`.
- **§4 phase-0 commands:** all 22 in Task 9's second test, the five host commands in Task 10.
- **§5 module map, phase-0 rows:** paths (2), store (3), error (2), models (4), settings (4), events (7), secrets (5), bootstrap (8).
- **§6 on-disk compatibility:** two-space JSON via tmp + rename (3), field order (4), same DDL (7), `ddd:<env>` service (5), `DDD_HOME` + `scratchEnv` (2).
- **§7 error handling:** `DddError` (2), envelope with bare message (10, 11).
- **§8 testing:** unit tests per module; `no-electron` (1), handler contract (9), CSP pin (10); renderer tests carried (12); `DDD_VERIFY` for the keychain (5); smoke (13).
