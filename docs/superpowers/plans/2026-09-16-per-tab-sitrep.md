# Per-Tab Sitrep Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `sitrep` widget bound to a project that reports what changed to its repo while you were away from the tab (processes stopped, files/commits changed, AI actions), with an always-on timeline and, after a long absence, a dismissible AI "while you were away" summary (local model, deterministic digest fallback). Then package a runnable build.

**Architecture:** Core owns the git delta (`repos/changes.ts` behind the `Runner` seam) and the AI prompt (`ai/sitrep.ts` + a `tab.sitrep` action routed local by default, invoked by a `tab_sitrep_generate` command mirroring `widget_instructions_compile`). The renderer owns a project-bound `SitrepWidget` plus pure helpers (`lib/sitrep.ts`: delta extraction, deterministic digest, away detection). `Tab` gains `lastVisitedAt`, stamped when leaving a tab. The summary caches in the widget's `config`.

**Tech Stack:** Electron 44, TypeScript 5.8, vitest 5, React 19, `node:child_process` (git via the Runner seam).

**Spec:** `docs/superpowers/specs/2026-09-16-per-tab-sitrep-design.md`

## Global Constraints

- `src/core` never imports electron. Git runs through the `Runner` seam (`src/core/dev/run.ts`: `type Runner = (file, args) => Promise<RunResult>`, `execFileRunner`, `lines(output)`); tests use a fake Runner. No network, no real `~/.ddd` in tests (`scratchEnv()` first for any `EnvRoot`).
- New commands are nodeDDD-only (no Rust counterpart). The contract test `src/main/commands.test.ts` asserts every Rust command is registered; confirm it does not also forbid extra commands. If it does, add `repo_changes_since` and `tab_sitrep_generate` to its allowed-extras set (do not weaken the Rust-coverage assertion). `NOT_YET_PORTED` stays `new Set([])`.
- AI types (verified): `route(env, settings, actionId, deps): { provider, model }`; `provider.complete(c: Completion): Promise<Draft>`; `Completion = { system: string; prompt: string; maxTokens: number; model: string }`; `Draft = { text, model, usage: { inputTokens, outputTokens, costMicros }, refusal: string | null }`. Route with `deps.sync` from `createCommands` (the same value `widget_instructions_compile` passes).
- Events (verified): `EventRow = { kind, source?, project?, tokensIn?, tokensOut?, costMicros?, meta?, id, ts }`; `eventsQuery(env, { since?, kindPrefix?, limit? })` orders newest-first, has NO project filter — filter client-side by the project **name** (job events log the name, not the registry id; reuse the About convention). Product state events are `product.start`/`product.stop`; AI events are `ai.*`.
- Renderer: logic in pure `lib/` functions with tests; components thin. Backward compatible — `Tab.lastVisitedAt`, the sitrep `config`, and the `sitrep` widget kind are all additive; existing layouts render unchanged.
- Both looks: base/classic in `src/renderer/src/styles/global.css`, Console overrides under `[data-look="console"]` in `console.css`. No icon library.
- The Features Guide must gain a `sitrep` entry (`WIDGET_HOW.sitrep` in `src/renderer/src/lib/guide.ts`); the guide drift-guard test enforces it.
- `npm test` and `npm run typecheck` exit 0 after every task (exit code is the gate; the two live FSEvents watcher tests may print FAIL under load and pass in isolation). No new npm dependency.
- Commit after every task. End every commit message with these two lines exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`

---

### Task 1: Git delta — `changesSince` and its command

**Files:**
- Create: `src/core/repos/changes.ts`, `src/core/repos/changes.test.ts`
- Modify: `src/main/commands.ts` (add `repo_changes_since`), `src/main/commands.test.ts` (if it forbids extra commands)

**Interfaces:**
- Produces: `RepoChanges = { commits: number; filesChanged: number; messages: string[] }`; `changesSince(runner: Runner, repoPath: string, sinceIso: string): Promise<RepoChanges>`; command `repo_changes_since({ env, path, since }): Promise<RepoChanges>`.

- [ ] **Step 1: Write the failing test**

`src/core/repos/changes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { changesSince } from "./changes";
import type { Runner, RunResult } from "../dev/run";

function fakeRunner(map: Record<string, RunResult>): Runner {
  return async (file, args) => {
    const key = [file, ...args].join(" ");
    for (const k of Object.keys(map)) if (key.includes(k)) return map[k];
    return { stdout: "", stderr: "", ok: false, code: 1 } as RunResult;
  };
}
const ok = (stdout: string): RunResult => ({ stdout, stderr: "", ok: true, code: 0 } as RunResult);

describe("changesSince", () => {
  it("counts commits and distinct files and keeps messages", async () => {
    const runner = fakeRunner({
      "log --since": ok("a1\tfix thing\nb2\tadd feature\n"), // hash<TAB>subject per line
      "log --name-only": ok("src/a.ts\nsrc/b.ts\nsrc/a.ts\n"), // duplicate a.ts counted once
    });
    const r = await changesSince(runner, "/repo", "2026-09-01T00:00:00.000Z");
    expect(r.commits).toBe(2);
    expect(r.filesChanged).toBe(2);
    expect(r.messages).toEqual(["fix thing", "add feature"]);
  });

  it("returns zeros when git fails (not a repo)", async () => {
    const runner: Runner = async () => ({ stdout: "", stderr: "fatal", ok: false, code: 128 } as RunResult);
    expect(await changesSince(runner, "/x", "2026-09-01T00:00:00.000Z")).toEqual({ commits: 0, filesChanged: 0, messages: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/repos/changes.test.ts` — expected: cannot resolve `./changes`.

- [ ] **Step 3: Write the module**

`src/core/repos/changes.ts`:

```ts
import { lines, type Runner } from "../dev/run";

export interface RepoChanges {
  commits: number;
  filesChanged: number;
  messages: string[];
}

/**
 * What changed in a git repo since an ISO timestamp: commit count, the set of
 * files those commits touched, and the commit subjects. Behind the Runner seam
 * so tests use a fake. A git failure (not a repo, path gone) is a normal empty
 * answer, like the dev-server scans — never an error.
 */
export async function changesSince(runner: Runner, repoPath: string, sinceIso: string): Promise<RepoChanges> {
  const base = ["-C", repoPath];
  const log = await runner("git", [...base, "log", `--since=${sinceIso}`, "--format=%h%x09%s"]);
  if (!log.ok) return { commits: 0, filesChanged: 0, messages: [] };
  const rows = lines(log.stdout).filter((l) => l.length > 0);
  const messages = rows.map((l) => l.split("\t").slice(1).join("\t")).filter((s) => s.length > 0);
  const names = await runner("git", [...base, "log", `--since=${sinceIso}`, "--name-only", "--format="]);
  const files = new Set(lines(names.stdout).map((l) => l.trim()).filter((l) => l.length > 0));
  return { commits: rows.length, filesChanged: files.size, messages };
}
```

(If `RunResult` field names differ from `{ stdout, ok }`, read `src/core/dev/run.ts` and match them in both the module and the test.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/repos/changes.test.ts` — expected: PASS.

- [ ] **Step 5: Add the command**

In `src/main/commands.ts`, add near the repos commands:

```ts
    repo_changes_since: async ({ env, path, since }) => {
      void env;
      return changesSince(execFileRunner, String(path), String(since));
    },
```

Import `changesSince` from `../core/repos/changes` and `execFileRunner` from `../core/dev/run` (reuse the existing import if present). Confirm the contract test still passes; if `commands.test.ts` asserts the registered set equals the Rust set exactly, add `repo_changes_since` to its allowed-extras list (leave the Rust-coverage check intact).

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/core/repos/changes.test.ts src/main/commands.test.ts` — expected: clean.

```bash
git add src/core/repos/changes.ts src/core/repos/changes.test.ts src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(repos): changesSince git delta and repo_changes_since command"
```

---

### Task 2: The `tab.sitrep` AI action and prompt

**Files:**
- Create: `src/core/ai/sitrep.ts`, `src/core/ai/sitrep.test.ts`
- Modify: `src/core/settings.ts` (routing default), `src/core/settings.test.ts` (if it asserts the routing map)

**Interfaces:**
- Produces: `ACTION = "tab.sitrep"`; `SitrepInput` (the shared delta type); `completionFor(input: SitrepInput, model: string): Completion`.

- [ ] **Step 1: Write the failing test**

`src/core/ai/sitrep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ACTION, completionFor, type SitrepInput } from "./sitrep";

const input: SitrepInput = {
  projectName: "acme",
  awayDays: 15,
  processesStopped: ["api", "worker"],
  processesRunning: 1,
  commits: 4,
  filesChanged: 12,
  commitMessages: ["fix login", "bump deps"],
  aiActions: [{ action: "mail.draft", count: 2 }],
};

describe("tab.sitrep prompt", () => {
  it("has the stable action id", () => {
    expect(ACTION).toBe("tab.sitrep");
  });
  it("puts the delta facts in the prompt and frames a brief report", () => {
    const c = completionFor(input, "llama3.1:8b");
    expect(c.model).toBe("llama3.1:8b");
    expect(c.prompt).toContain("acme");
    expect(c.prompt).toContain("12"); // files changed
    expect(c.prompt).toContain("api"); // a stopped process
    expect(c.system.toLowerCase()).toContain("situation report");
    expect(c.maxTokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/ai/sitrep.test.ts` — expected: cannot resolve `./sitrep`.

- [ ] **Step 3: Write the module**

`src/core/ai/sitrep.ts`:

```ts
import type { Completion } from "./provider";

export const ACTION = "tab.sitrep";

export interface SitrepInput {
  projectName: string;
  awayDays: number;
  processesStopped: string[];
  processesRunning: number;
  commits: number;
  filesChanged: number;
  commitMessages: string[];
  aiActions: { action: string; count: number }[];
}

const SYSTEM =
  "You write a brief situation report for a developer returning to a project " +
  "after time away. Two or three short sentences, plain and factual, no " +
  "preamble, no bullet points, no markdown. Say what changed; do not speculate.";

export function completionFor(input: SitrepInput, model: string): Completion {
  const facts = [
    `Project: ${input.projectName}.`,
    `Away for about ${input.awayDays} days.`,
    input.commits > 0
      ? `${input.commits} commit(s) touched ${input.filesChanged} file(s)${input.commitMessages.length ? ": " + input.commitMessages.slice(0, 5).join("; ") : ""}.`
      : "No new commits.",
    input.processesStopped.length > 0
      ? `Processes that stopped: ${input.processesStopped.join(", ")}. ${input.processesRunning} still running.`
      : `${input.processesRunning} process(es) running.`,
    input.aiActions.length > 0
      ? "AI activity: " + input.aiActions.map((a) => `${a.action} ×${a.count}`).join(", ") + "."
      : "No AI activity.",
  ].join("\n");
  return {
    system: SYSTEM,
    prompt: `Here is what happened while the developer was away:\n\n${facts}\n\nWrite the situation report.`,
    maxTokens: 400,
    model,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/ai/sitrep.test.ts` — expected: PASS.

- [ ] **Step 5: Route it local by default**

In `src/core/settings.ts` `defaultAiSettings().routing`, add `"tab.sitrep": "local"` alongside the other routing entries. The existing routing backfill adds it to saved `settings.json` with no migration. If `src/core/settings.test.ts` asserts the exact routing map, add the new key there too.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/core/ai/sitrep.test.ts src/core/settings.test.ts` — expected: clean.

```bash
git add src/core/ai/sitrep.ts src/core/ai/sitrep.test.ts src/core/settings.ts src/core/settings.test.ts
git commit -m "feat(ai): tab.sitrep action, prompt builder, and local routing default"
```

---

### Task 3: The `tab_sitrep_generate` command

**Files:**
- Modify: `src/main/commands.ts` (add the command), `src/main/commands.test.ts` (allowed-extras, if needed)

**Interfaces:**
- Consumes: `sitrep.ACTION`, `sitrep.completionFor`, `route`, `settingsLoad`, `events.log`.
- Produces: `tab_sitrep_generate({ env, input }): Promise<{ text: string; model: string }>`.

- [ ] **Step 1: Add the command (mirror `widget_instructions_compile`)**

In `src/main/commands.ts`:

```ts
    tab_sitrep_generate: async ({ env, input }) => {
      const r = root(env);
      const settings = settingsLoad(r);
      const chosen = route(r, settings, sitrep.ACTION, deps.sync);
      const si = input as sitrep.SitrepInput;
      const draft = await chosen.provider.complete(sitrep.completionFor(si, chosen.model));
      if (draft.refusal !== null) throw DddError.invalid(draft.refusal);
      events.log(r, {
        kind: "ai.tab.sitrep",
        source: chosen.provider.id,
        project: si.projectName,
        tokensIn: draft.usage.inputTokens,
        tokensOut: draft.usage.outputTokens,
        costMicros: draft.usage.costMicros,
        meta: { away: si.awayDays },
      });
      return { text: draft.text, model: chosen.model };
    },
```

Import `* as sitrep from "../core/ai/sitrep"` (match how the file imports `instructions`/`events`/`route`). A provider error (Ollama down) propagates as `DddError` — the renderer catches it and uses the deterministic digest.

- [ ] **Step 2: Add the renderer IPC wrapper**

In `src/renderer/src/lib/ipc.ts`, add (matching the existing wrapper style, non-coalesced since it is a write/generate):

```ts
  tabSitrepGenerate(env: string, input: unknown): Promise<{ text: string; model: string }> {
    if (!isNative) return Promise.resolve({ text: "", model: "" });
    return call("tab_sitrep_generate", { env, input });
  },
  repoChangesSince(env: string, path: string, since: string): Promise<{ commits: number; filesChanged: number; messages: string[] }> {
    if (!isNative) return Promise.resolve({ commits: 0, filesChanged: 0, messages: [] });
    return call("repo_changes_since", { env, path, since });
  },
```

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/main/commands.test.ts` — expected: clean.

```bash
git add src/main/commands.ts src/main/commands.test.ts src/renderer/src/lib/ipc.ts
git commit -m "feat(main): tab_sitrep_generate command and renderer IPC wrappers"
```

---

### Task 4: Renderer pure logic — delta, digest, away, week granularity

**Files:**
- Create: `src/renderer/src/lib/sitrep.ts`, `src/renderer/src/lib/sitrep.test.ts`
- Modify: `src/renderer/src/lib/products.ts` (extend `since()`), `src/renderer/src/lib/products.test.ts`

**Interfaces:**
- Consumes: `SitrepInput` (from `src/core/ai/sitrep`), `EventRow`, `Product`, `RepoChanges` shape.
- Produces: `extractDelta(args): SitrepInput`, `buildDigest(input: SitrepInput): string`, `awayInfo(lastVisitedAt: string | null | undefined, now: number, thresholdDays: number): { away: boolean; days: number }`.

- [ ] **Step 1: Write the failing test**

`src/renderer/src/lib/sitrep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { awayInfo, buildDigest, extractDelta } from "./sitrep";
import type { EventRow, Product } from "../types";

const day = 86_400_000;
const now = Date.parse("2026-09-16T00:00:00.000Z");

describe("awayInfo", () => {
  it("is not away when never left", () => {
    expect(awayInfo(null, now, 14).away).toBe(false);
  });
  it("is away past the threshold", () => {
    const r = awayInfo(new Date(now - 20 * day).toISOString(), now, 14);
    expect(r.away).toBe(true);
    expect(r.days).toBe(20);
  });
  it("is not away within the threshold", () => {
    expect(awayInfo(new Date(now - 3 * day).toISOString(), now, 14).away).toBe(false);
  });
});

describe("extractDelta", () => {
  const products = [
    { projectId: "p1", productId: "api", name: "api", state: { state: "stopped" } },
    { projectId: "p1", productId: "web", name: "web", state: { state: "running" } },
  ] as unknown as Product[];
  const events = [
    { id: 3, ts: "2026-09-10T00:00:00Z", kind: "ai.mail.draft", project: "acme" },
    { id: 2, ts: "2026-09-09T00:00:00Z", kind: "ai.mail.draft", project: "acme" },
    { id: 1, ts: "2026-09-08T00:00:00Z", kind: "product.stop", project: "acme" },
  ] as EventRow[];

  it("summarizes processes, repo changes and AI actions", () => {
    const d = extractDelta({
      projectName: "acme",
      projectId: "p1",
      awayDays: 15,
      products,
      events,
      changes: { commits: 4, filesChanged: 12, messages: ["fix"] },
    });
    expect(d.processesRunning).toBe(1);
    expect(d.processesStopped).toContain("api");
    expect(d.commits).toBe(4);
    expect(d.filesChanged).toBe(12);
    expect(d.aiActions).toEqual([{ action: "mail.draft", count: 2 }]);
  });
});

describe("buildDigest", () => {
  it("renders counts and handles an empty delta", () => {
    const text = buildDigest({ projectName: "acme", awayDays: 15, processesStopped: ["api"], processesRunning: 1, commits: 4, filesChanged: 12, commitMessages: [], aiActions: [] });
    expect(text).toContain("12");
    expect(text).toContain("api");
    const empty = buildDigest({ projectName: "acme", awayDays: 15, processesStopped: [], processesRunning: 0, commits: 0, filesChanged: 0, commitMessages: [], aiActions: [] });
    expect(empty.toLowerCase()).toContain("nothing");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/lib/sitrep.test.ts` — expected: cannot resolve `./sitrep`.

- [ ] **Step 3: Write the module**

`src/renderer/src/lib/sitrep.ts`:

```ts
import type { EventRow, Product } from "../types";
import { filterByProject } from "./products";

// Structural twin of core's SitrepInput (src/core/ai/sitrep.ts). Declared here
// rather than imported so the renderer TS project does not reach across the
// core/renderer boundary — the same both-sides-declare convention the port uses
// for Product/ProductState. The command casts the object it receives.
export interface SitrepInput {
  projectName: string;
  awayDays: number;
  processesStopped: string[];
  processesRunning: number;
  commits: number;
  filesChanged: number;
  commitMessages: string[];
  aiActions: { action: string; count: number }[];
}

export function awayInfo(lastVisitedAt: string | null | undefined, now: number, thresholdDays: number): { away: boolean; days: number } {
  if (!lastVisitedAt) return { away: false, days: 0 };
  const ms = now - Date.parse(lastVisitedAt);
  if (!Number.isFinite(ms) || ms < 0) return { away: false, days: 0 };
  const days = Math.floor(ms / 86_400_000);
  return { away: days >= thresholdDays, days };
}

export function extractDelta(args: {
  projectName: string;
  projectId: string;
  awayDays: number;
  products: Product[];
  events: EventRow[];
  changes: { commits: number; filesChanged: number; messages: string[] };
}): SitrepInput {
  const mine = filterByProject(args.products, args.projectId);
  const processesStopped = mine.filter((p) => p.state.state !== "running").map((p) => p.name || p.productId);
  const processesRunning = mine.filter((p) => p.state.state === "running").length;
  const forProject = args.events.filter((e) => e.project === args.projectName || e.project === args.projectId);
  const counts = new Map<string, number>();
  for (const e of forProject) {
    if (e.kind.startsWith("ai.")) {
      const action = e.kind.slice(3);
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  const aiActions = [...counts.entries()].map(([action, count]) => ({ action, count }));
  return {
    projectName: args.projectName,
    awayDays: args.awayDays,
    processesStopped,
    processesRunning,
    commits: args.changes.commits,
    filesChanged: args.changes.filesChanged,
    commitMessages: args.changes.messages,
    aiActions,
  };
}

export function isEmptyDelta(d: SitrepInput): boolean {
  return d.commits === 0 && d.processesStopped.length === 0 && d.aiActions.length === 0;
}

export function buildDigest(d: SitrepInput): string {
  if (isEmptyDelta(d)) return `Nothing changed in ${d.projectName} while you were away.`;
  const parts: string[] = [];
  if (d.commits > 0) parts.push(`${d.commits} commit${d.commits === 1 ? "" : "s"} touched ${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"}`);
  if (d.processesStopped.length > 0) parts.push(`${d.processesStopped.join(", ")} stopped`);
  if (d.aiActions.length > 0) parts.push("AI: " + d.aiActions.map((a) => `${a.action} ×${a.count}`).join(", "));
  return parts.join(". ") + ".";
}
```

(`SitrepInput` is declared locally here and structurally in `src/core/ai/sitrep.ts`; the two must stay in sync — same shape, both sides. The command casts the received object to its core type.)

- [ ] **Step 4: Extend `since()` with weeks**

In `src/renderer/src/lib/products.ts` `since()`, after the hours/days branches add a week granularity: when days `>= 7`, return `${Math.floor(days / 7)}w`. Add a test in `products.test.ts` asserting a 15-day span renders `"2w"`. Keep all existing assertions green.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/renderer/src/lib/sitrep.test.ts src/renderer/src/lib/products.test.ts` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/sitrep.ts src/renderer/src/lib/sitrep.test.ts src/renderer/src/lib/products.ts src/renderer/src/lib/products.test.ts
git commit -m "feat(sitrep): pure delta/digest/away helpers and week granularity"
```

---

### Task 5: `Tab.lastVisitedAt` and the leave-stamp

**Files:**
- Modify: `src/renderer/src/types/index.ts` (`Tab`), `src/renderer/src/state/store.ts` (`selectTab`)

**Interfaces:**
- Produces: `Tab.lastVisitedAt?: string | null`, stamped on the outgoing tab in `selectTab`.

- [ ] **Step 1: Add the field**

In `src/renderer/src/types/index.ts`, add to `Tab`: `/** ISO time the user last switched away from this tab; drives the sitrep "away" banner. */ lastVisitedAt?: string | null;`.

- [ ] **Step 2: Stamp the outgoing tab**

In `src/renderer/src/state/store.ts` `selectTab(tabId)`, when `previous !== tabId` and `previous` is a real tab id, set that previous tab's `lastVisitedAt = new Date().toISOString()` in its environment's layout and persist it (use `envOf(get().layouts, previous)` for the env, map the tab, `persistLayout`, and update `layouts` in the same `set`). Do this without disturbing the existing `activeTabId`/overview/`tab.switch` logic. Keep it a no-op when `previous` is null (first selection).

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck` and `npm test` — expected: green (exit 0). Manually confirm nothing that reads `Tab` breaks on the optional field.

```bash
git add src/renderer/src/types/index.ts src/renderer/src/state/store.ts
git commit -m "feat(tabs): stamp lastVisitedAt when leaving a tab"
```

---

### Task 6: The Sitrep widget

**Files:**
- Create: `src/renderer/src/widgets/SitrepWidget.tsx`
- Modify: `src/renderer/src/widgets/registry.tsx` (register `sitrep`), `src/renderer/src/lib/guide.ts` (`WIDGET_HOW.sitrep`), `src/renderer/src/lib/promote.ts` (+ `src/renderer/src/lib/promote.test.ts`), `src/renderer/src/styles/global.css`, `src/renderer/src/styles/console.css`

**Interfaces:**
- Consumes: `extractDelta`/`buildDigest`/`awayInfo` (Task 4), `ipc.projectsList`/`productsList`/`eventsQuery`/`repoChangesSince`/`tabSitrepGenerate`, the store (to find its tab's `lastVisitedAt`).

- [ ] **Step 1: Build the widget**

`src/renderer/src/widgets/SitrepWidget.tsx` — read `AboutWidget.tsx` for the `WidgetViewProps` shape, `firstLoad`/`useRemembered`, and the detail idiom. Bind to `const projectId = String(widget.config.projectId ?? "")`; `const awayDays = Number(widget.config.awayDays ?? 14)`. Find the widget's own tab via the store (`useStore`, locate the tab whose `widgets` include `widget.id`) to read `lastVisitedAt`. On load/refresh (parallel):
- `ipc.projectsList(environmentId)` → the project (by `id === projectId`) for `name` and `path`;
- `ipc.productsList(environmentId)`;
- `ipc.eventsQuery(environmentId, { since: lastVisitedAt ?? undefined, kindPrefix: "ai.", limit: 200 })` plus a second query with `kindPrefix: "product."` (or one `{ limit: 300 }` and filter) — enough to cover AI and process events since the away point;
- `ipc.repoChangesSince(environmentId, project.path, lastVisitedAt ?? <30d ago>)`.

Compute `const delta = extractDelta({ projectName: project.name, projectId, awayDays: away.days, products, events, changes })` and `const away = awayInfo(lastVisitedAt, Date.now(), awayDays)`.

Render, in the detail idiom:
- Always: a compact timeline/digest of the delta (reuse `buildDigest` for a one-line headline plus a short list of recent events with `since(event.ts)` relative times).
- When `away.away` and the delta is non-empty: a dismissible `.sitrep-banner` at the top. If `widget.config.sitrep` caches text covering this range, show it; else call `ipc.tabSitrepGenerate(environmentId, delta)`, cache `{ text, coveredThroughTs: <newest event ts or now>, generatedAt, model }` into `widget.config.sitrep` via `updateWidget`, and show it. On a thrown error, show `buildDigest(delta)` and a "Summarise with AI" button that retries. A close control writes a `dismissedRange` into `config.sitrep` so the banner stays closed for this range. Never throw — the widget must render even with Ollama down (the InstructionsPanel rule).
- Empty states: no project bound → "Bind a project to see its sitrep"; empty delta → "Nothing changed while you were away."

- [ ] **Step 2: Register the kind and its guide entry**

In `src/renderer/src/widgets/registry.tsx`, add to `WIDGETS`:

```tsx
{
  kind: "sitrep",
  name: "Sitrep",
  description: "What changed in a repo while you were away: processes, commits, AI.",
  source: "local",
  needsConnection: false,
  flush: true,
  View: SitrepWidget,
},
```

Import `SitrepWidget`. Do NOT add it to `PRESETS` (created by Promote to tab). In `src/renderer/src/lib/guide.ts`, add to `WIDGET_HOW`: `sitrep: { how: "Bind it to a project; after you have been away a while it summarises what changed." }`.

- [ ] **Step 3: Promote adds a sitrep widget**

In `src/renderer/src/lib/promote.ts` `buildPromotedTab`, add a `sitrep` widget for the project (`config: { projectId: input.projectId }`, `title: input.name`) with a non-overlapping grid cell. Update `src/renderer/src/lib/promote.test.ts`: the tab now holds `["about","launcher","notes","products","sitrep"]`, the sitrep carries the projectId, and cells remain unique.

- [ ] **Step 4: Style the banner and timeline (both looks)**

Add `.sitrep-banner` (a callout with a close `×`), `.sitrep-timeline`/`.sitrep-line` to the widget-primitives block of `global.css`, using existing tokens; add `[data-look="console"]` overrides in `console.css` only where the console treatment needs them (follow the `.row-detail`/`.empty` precedent).

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/renderer/src/lib/promote.test.ts src/renderer/src/lib/guide.test.ts src/renderer/src/lib/sitrep.test.ts` — expected: clean (guide drift-guard now covers `sitrep`).

```bash
git add src/renderer/src/widgets/SitrepWidget.tsx src/renderer/src/widgets/registry.tsx src/renderer/src/lib/guide.ts src/renderer/src/lib/promote.ts src/renderer/src/lib/promote.test.ts src/renderer/src/styles/global.css src/renderer/src/styles/console.css
git commit -m "feat(widgets): the per-tab Sitrep widget"
```

---

### Task 7: Verification, README, and a packaged build

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full verification**

Run: `npm test` (capture the EXIT CODE — the gate; if the FSEvents watcher tests print FAIL, re-run `src/core/watcher.test.ts` and `src/main/commands.test.ts` in isolation and confirm they pass), `npm run typecheck`, and `npm run build`. All must be green.

- [ ] **Step 2: README**

In `README.md`'s "Beyond the port" section, add the Sitrep widget: a per-tab, project-bound report of what changed in a repo while you were away (processes stopped, commits and files changed, AI actions), with a local-model "while you were away" summary and a deterministic fallback.

- [ ] **Step 3: Package a runnable build**

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir 2>&1 | tail -20` — expected: electron-builder writes `dist/mac-arm64/nodeDDD.app` (or `dist/mac/...` on Intel). Confirm the bundle exists and prints its id:

```bash
APP=$(ls -d dist/mac*/nodeDDD.app | head -1)
test -d "$APP" && echo "app built: $APP"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
```

Report the artifact path in your report so the controller can surface it to the user. (`dist/` is gitignored — do not stage it.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): the per-tab sitrep widget"
```
