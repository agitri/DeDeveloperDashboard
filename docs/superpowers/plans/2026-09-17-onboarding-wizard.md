# Interactive Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hands-on "DO" wizard: it instructs the user to perform a real action, spotlights the target, detects completion by watching the store, rewards (🎉), and advances — flow: welcome → create an environment → tabs → add a widget → open settings → finish. Auto-starts on a fresh install, replayable. Then rebuild the app.

**Architecture:** A `wizard` flag on `global.json` (mirrors `appearance`). Pure step definitions with testable `done` predicates. A controller hook subscribes to the zustand stores and diffs a `WizardSnapshot` against a per-step baseline. A non-modal coach panel + a box-shadow spotlight overlay mount in `App.tsx`'s overlay layer. `data-wizard-target` hooks on the real buttons.

**Tech Stack:** Electron 44, TypeScript 5.8, vitest 5, React 19, zustand 5 (vanilla `.subscribe`).

**Spec:** `docs/superpowers/specs/2026-09-17-onboarding-wizard-design.md`

## Global Constraints

- `src/core` never imports electron. `global_wizard_save` is nodeDDD-only (no Rust counterpart) → add it to `HOST_COMMANDS` in `src/main/commands.ts`; keep `NOT_YET_PORTED` empty and the Rust-coverage assertion intact.
- Detection uses the vanilla zustand `useStore.subscribe`/`useUi.subscribe` (full-state listeners) diffing a small snapshot; no new event kinds are required. Baselines are captured at step start so pre-existing state never auto-completes a step.
- The wizard is non-modal: the coach panel and spotlight never block interaction (spotlight overlay is `pointer-events: none`). Every step has Show me / Skip step / Exit tour; an auto-hint appears after ~15s.
- Persistence: `Global.wizard = { completed: boolean; step: number } | null` in `~/.ddd/global.json`, following exactly how `appearance` is stored/parsed/migrated (`src/core/global.ts`, `src/core/models.ts`). Backward compatible: a `global.json` without `wizard` still loads (treated as not-completed → auto-start).
- Renderer: logic in pure tested `lib/`/`onboarding/` functions; components thin. Both looks (base/classic in `global.css`, console overrides under `[data-look="console"]` in `console.css`); no icon library; use text/CSS glyphs.
- The Features Guide gains a "Guided tour" entry (`GUIDE_CONCEPTS` in `src/renderer/src/lib/guide.ts`) — the standing rule.
- `npm test` and `npm run typecheck` exit 0 after every task (the two live FSEvents watcher tests are a known environmental flake — judge by whether ONLY those fail; re-run them in isolation). No new npm dependency.
- Commit after every task. End every commit message with these two lines exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`

---

### Task 1: Persist the wizard flag on `global.json`

**Files:**
- Modify: `src/core/models.ts` (`Global`/`StoredGlobal`, `globalFromJson`, `defaultGlobal`), `src/core/global.ts` (`globalWizardSave`), `src/main/commands.ts` (`global_wizard_save` + `HOST_COMMANDS`), `src/renderer/src/lib/ipc.ts` (`globalWizardSave`), `src/renderer/src/types/index.ts` (renderer `Global` twin if one exists there)
- Test: `src/core/global.test.ts` and/or `src/core/models.test.ts`

**Interfaces:**
- Produces: `WizardState = { completed: boolean; step: number }`; `Global.wizard: WizardState | null`; `globalWizardSave(completed, step)`; `ipc.globalWizardSave(completed, step)`.

- [ ] **Step 1: Write the failing test**

In `src/core/global.test.ts` (or `models.test.ts`), add tests: (a) `defaultGlobal().wizard` is `null`; (b) `globalFromJson` on a JSON object WITHOUT `wizard` yields `wizard: null` (backward-compat), and WITH `wizard: {completed:true, step:3}` preserves it; (c) `globalWizardSave(true, 5)` (against a `scratchEnv()`/scratch `DDD_HOME`) writes and a subsequent `globalLoad()` returns `wizard: {completed:true, step:5}`. Follow the existing appearance tests for the scratch-home setup.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/global.test.ts src/core/models.test.ts` — expected: fails (no `wizard`).

- [ ] **Step 3: Implement**

In `src/core/models.ts`:
- Add `export interface WizardState { completed: boolean; step: number }`.
- Add `wizard: WizardState | null` to both `Global` and `StoredGlobal` (after `appearance`).
- In `defaultGlobal()` return `wizard: null` (a fresh install has not started the tour).
- In `globalFromJson`, parse it defensively:

```ts
  const wizardRaw = o.wizard;
  const wizard =
    wizardRaw && typeof wizardRaw === "object"
      ? {
          completed: (wizardRaw as Record<string, unknown>).completed === true,
          step: typeof (wizardRaw as Record<string, unknown>).step === "number" ? (wizardRaw as Record<string, unknown>).step as number : 0,
        }
      : null;
```

and include `wizard` in the returned object.

In `src/core/global.ts`, add (after `globalAppearanceSave`):

```ts
/** The onboarding tour's state — app-global, like appearance. */
export function globalWizardSave(completed: boolean, step: number): Global {
  const g = globalLoad();
  g.wizard = { completed, step };
  globalSave(g);
  return g;
}
```

Import `type WizardState` where needed.

In `src/main/commands.ts`, add the handler (near `global_appearance_save`) and register `"global_wizard_save"` in `HOST_COMMANDS`:

```ts
    global_wizard_save: async ({ completed, step }) => globalWizardSave(Boolean(completed), Number(step ?? 0)),
```

(import `globalWizardSave` alongside `globalAppearanceSave`.)

In `src/renderer/src/lib/ipc.ts`, add (template: `globalAppearanceSave`):

```ts
  globalWizardSave(completed: boolean, step: number): Promise<Global> {
    if (!isNative) return Promise.resolve(/* the mock Global */ null as unknown as Global);
    return call("global_wizard_save", { completed, step });
  },
```

(match the file's existing `globalAppearanceSave` mock-fallback style — reuse whatever it returns in the `!isNative` branch.) If `src/renderer/src/types/index.ts` declares a renderer `Global` type, add the optional `wizard` field there too.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/global.test.ts src/core/models.test.ts` and `npm run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/models.ts src/core/global.ts src/main/commands.ts src/renderer/src/lib/ipc.ts src/renderer/src/types/index.ts src/core/global.test.ts src/core/models.test.ts
git commit -m "feat(global): persist the onboarding wizard flag on global.json"
```

---

### Task 2: The step definitions (pure)

**Files:**
- Create: `src/renderer/src/onboarding/steps.ts`, `src/renderer/src/onboarding/steps.test.ts`

**Interfaces:**
- Produces: `WizardSnapshot`, `WizardStep`, `STEPS: WizardStep[]`, `progress(index, total)`.

- [ ] **Step 1: Write the failing test**

`src/renderer/src/onboarding/steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STEPS, progress, type WizardSnapshot } from "./steps";

const base: WizardSnapshot = { envCount: 1, tabCount: 2, widgetCount: 3, activeTabId: "t1", view: "board" };

describe("wizard steps", () => {
  it("every step has copy and a done predicate", () => {
    for (const s of STEPS) {
      expect(s.title.trim()).not.toBe("");
      expect(s.instruction.trim()).not.toBe("");
      expect(typeof s.done).toBe("function");
    }
  });

  it("the flow is welcome → environment → tab → switch → widget → settings → finish", () => {
    expect(STEPS.map((s) => s.id)).toEqual(["welcome", "environment", "tab", "switch", "widget", "settings", "finish"]);
  });

  const doneOf = (id: string) => STEPS.find((s) => s.id === id)!.done;

  it("environment step completes only when the env count rises", () => {
    expect(doneOf("environment")(base, { ...base, envCount: 2 })).toBe(true);
    expect(doneOf("environment")(base, { ...base, tabCount: 9 })).toBe(false);
  });
  it("tab step completes on a new tab; switch step on a changed active tab; widget step on a new widget", () => {
    expect(doneOf("tab")(base, { ...base, tabCount: 3 })).toBe(true);
    expect(doneOf("switch")(base, { ...base, activeTabId: "t2" })).toBe(true);
    expect(doneOf("widget")(base, { ...base, widgetCount: 4 })).toBe(true);
  });
  it("settings step completes when the settings view is open", () => {
    expect(doneOf("settings")(base, { ...base, view: "settings" })).toBe(true);
    expect(doneOf("settings")(base, base)).toBe(false);
  });
  it("welcome and finish auto-complete (advanced by the user, not an action)", () => {
    expect(doneOf("welcome")(base, base)).toBe(true);
    expect(doneOf("finish")(base, base)).toBe(true);
  });

  it("progress is 1-based over the total", () => {
    expect(progress(0, 7)).toEqual({ current: 1, total: 7 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/onboarding/steps.test.ts` — expected: cannot resolve `./steps`.

- [ ] **Step 3: Write the module**

`src/renderer/src/onboarding/steps.ts`:

```ts
export interface WizardSnapshot {
  envCount: number;
  tabCount: number;
  widgetCount: number;
  activeTabId: string | null;
  view: string;
}

export interface WizardStep {
  id: string;
  title: string;
  instruction: string;
  shortcut?: string; // display glyphs, e.g. "⌘⇧A"
  target?: string; // a data-wizard-target key to spotlight
  hint: string; // shown by "Show me" / auto-hint
  /** Whether the user has completed this step, given the baseline captured when
   *  the step began and the current snapshot. Pure. */
  done(baseline: WizardSnapshot, current: WizardSnapshot): boolean;
}

const advanceable = () => true; // welcome/finish: the user clicks Next

export const STEPS: WizardStep[] = [
  {
    id: "welcome",
    title: "Welcome — let's do this hands-on",
    instruction: "This tour has you actually try each thing. Ready?",
    hint: "Click Next to begin. You can exit anytime.",
    done: advanceable,
  },
  {
    id: "environment",
    title: "Make an environment",
    instruction: "Environments are separate boards. Create one: press ⌘⇧N, then Create.",
    shortcut: "⌘⇧N",
    target: "environments",
    hint: "⌘⇧N opens Settings → Environments. Type a name and click Create.",
    done: (b, c) => c.envCount > b.envCount,
  },
  {
    id: "tab",
    title: "Add a tab",
    instruction: "Each environment holds tabs. Add one with ⌘T.",
    shortcut: "⌘T",
    target: "new-tab",
    hint: "⌘T adds a tab, or click the + at the end of the tab strip.",
    done: (b, c) => c.tabCount > b.tabCount,
  },
  {
    id: "switch",
    title: "Switch tabs",
    instruction: "Move between tabs with ⌃Tab (or click one).",
    shortcut: "⌃⇥",
    target: "tab-strip",
    hint: "Click a different tab in the strip, or press ⌃Tab.",
    done: (b, c) => c.activeTabId !== b.activeTabId,
  },
  {
    id: "widget",
    title: "Add a widget",
    instruction: "Widgets show your stuff. Open the picker with ⌘⇧A and add one.",
    shortcut: "⌘⇧A",
    target: "board",
    hint: "⌘⇧A opens the widget picker. Pick anything — you can remove it later.",
    done: (b, c) => c.widgetCount > b.widgetCount,
  },
  {
    id: "settings",
    title: "Open settings",
    instruction: "Everything is configured in Settings. Open it with ⌘,.",
    shortcut: "⌘,",
    target: "settings",
    hint: "⌘, opens Settings, or click the gear. Connections and AI live there.",
    done: (b, c) => c.view === "settings",
  },
  {
    id: "finish",
    title: "You're set 🎉",
    instruction: "That's the tour. Reopen it anytime from the Features Guide.",
    hint: "Click Finish. The guide (header ? or ⌘K) can replay this later.",
    done: advanceable,
  },
];

export function progress(index: number, total: number): { current: number; total: number } {
  return { current: index + 1, total };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/onboarding/steps.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/onboarding/steps.ts src/renderer/src/onboarding/steps.test.ts
git commit -m "feat(wizard): pure step definitions and done predicates"
```

---

### Task 3: The wizard engine — controller, spotlight, coach panel, targets, trigger

**Files:**
- Create: `src/renderer/src/onboarding/useWizard.ts`, `src/renderer/src/components/Wizard.tsx`, `src/renderer/src/components/Spotlight.tsx`
- Modify: `src/renderer/src/components/App.tsx` (mount `<Wizard/>` in the overlays fragment; first-run trigger), `src/renderer/src/components/TabStrip.tsx` (add `data-wizard-target` to the new-tab button, the tab strip, the environment area), `src/renderer/src/components/ConsoleRail.tsx` (settings target), `src/renderer/src/styles/global.css` + `console.css`

**Interfaces:**
- Consumes: `STEPS`/`WizardSnapshot`/`progress` (Task 2), `ipc.globalWizardSave` + `ipc.globalLoad` (Task 1), `useStore`, `useUi`.

- [ ] **Step 1: The controller `useWizard.ts`**

A hook returning `{ active, step, index, showHint, reward, start, skip, exit, showMe }`. Read `src/renderer/src/state/store.ts`/`ui.ts` for the exact selectors. Implementation notes:
- Build `snapshot()` from the stores: `envCount = useStore.getState().global?.environments.length ?? 0`, `tabCount = useStore.getState().tabs().length`, `widgetCount = useStore.getState().activeTab()?.widgets.length ?? 0`, `activeTabId = useStore.getState().activeTabId`, `view = useStore.getState().view`.
- On `start(fromStep = 0)`: set `active`, `index = fromStep`, capture `baseline = snapshot()`, reset hint timer.
- Subscribe to BOTH `useStore.subscribe` and `useUi.subscribe` while active; on any change compute `current = snapshot()` and auto-advance ONLY on a genuine false→true transition from the baseline: `if (!STEPS[index].done(baseline, baseline) && STEPS[index].done(baseline, current))` → set `reward` (🎉) briefly, then advance (`index+1`, new `baseline`, persist `ipc.globalWizardSave(false, index+1)`, reset the ~15s hint timer). **This guard is load-bearing:** welcome/finish have an always-true `done` (satisfied at baseline), so they are NOT auto-advanced — they advance only when the user clicks "Next". It also prevents an action-step that happens to be already-satisfied from skipping. "Next" (see Step 3) advances the current step unconditionally.
- `skip()` advances without persisting completion; `exit()` and finishing the last step call `ipc.globalWizardSave(true, STEPS.length)` and set `active = false`. `showMe()` sets `showHint = true`.
- Clean up subscriptions and the timer on `exit`/unmount (return the unsubscribe from an effect). Guard against setState-after-unmount.

- [ ] **Step 2: The spotlight `Spotlight.tsx`**

Props: `{ target?: string; intense?: boolean }`. If `target` is set, find `document.querySelector('[data-wizard-target="' + target + '"]')`; read `getBoundingClientRect()`; render a `position: fixed` div at that rect (a few px padding, rounded) whose dimming comes from `box-shadow: 0 0 0 9999px rgba(0,0,0,VAR)` (a bigger alpha when `intense`), with `pointer-events: none` so clicks reach the real element. Recompute the rect on `scroll`/`resize` (capture-phase scroll listener) and whenever `target`/`intense` change; use `requestAnimationFrame` to avoid layout thrash. If the element is missing, render nothing (no dim) — the step is still usable via the panel. Never blocks input.

- [ ] **Step 3: The coach panel `Wizard.tsx`**

Renders nothing when `!active`. Otherwise a corner card (mount it, plus `<Spotlight target={step.target} intense={showHint}/>`, at the end of the overlays fragment in `App.tsx`). Shows: `progress` ("2/7"), the step title, instruction, the `shortcut` as a key glyph, and — when `showHint` — the `hint`. Buttons: "Show me" (calls `showMe`), "Skip" (`skip`), "Exit" (`exit`), and a "Next" that advances welcome/finish (and is a no-op-friendly advance elsewhere). When `reward` is set, show the 🎉 state briefly. Use the house modal/panel classes but positioned as a non-blocking corner card (not `.scrim`). Keyboard: Escape calls `exit`.

- [ ] **Step 4: Targets, mount, and first-run trigger**

- In `TabStrip.tsx`: add `data-wizard-target="new-tab"` to the new-tab button (`.strip-add`), `data-wizard-target="tab-strip"` to the strip container (`.strip`), and `data-wizard-target="environments"` to the environment area (`.env-tab`/`.env-name`).
- In `App.tsx`: add `data-wizard-target="settings"` to the settings gear (`.icon-btn[aria-label="App settings"]`) and `data-wizard-target="board"` to the board/canvas container; render `<Wizard/>` in the overlays fragment. In `ConsoleRail.tsx`: add `data-wizard-target="settings"` to the rail settings toggle (so it works in the console look too).
- First-run trigger: where the app finishes loading (after `useStore` is `ready` and the board renders), if `useStore.getState().global?.wizard` is null or `!completed`, call `start(global.wizard?.step ?? 0)`. Do this once (guard with a ref) and only in the native app path.
- **Replay trigger (own it here so Task 4 stays trivial):** add a `tourRequested: boolean` + `requestTour()` / `clearTourRequest()` to `useUi` (`src/renderer/src/state/ui.ts`), and have the mounted `<Wizard/>` (or `useWizard`) watch `tourRequested`: when it becomes true, `start(0)` and `clearTourRequest()`. Route the first-run trigger through the same `start(...)`. Task 4's palette action and guide button just call `useUi.getState().requestTour()`.

- [ ] **Step 5: Styles**

Add `.wizard-panel` (corner card), `.wizard-*` (progress, buttons, key glyph, reward) and `.wizard-spotlight` to `global.css` using existing tokens; add `[data-look="console"]` overrides in `console.css` where needed.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck` and `npm test` — expected: green (only the watcher flake may appear; re-run those files in isolation). Manually reason through: the spotlight overlay is `pointer-events:none`; the panel doesn't cover the targets it points at.

```bash
git add src/renderer/src/onboarding/useWizard.ts src/renderer/src/components/Wizard.tsx src/renderer/src/components/Spotlight.tsx src/renderer/src/components/App.tsx src/renderer/src/components/TabStrip.tsx src/renderer/src/components/ConsoleRail.tsx src/renderer/src/styles/global.css src/renderer/src/styles/console.css
git commit -m "feat(wizard): the interactive coach panel, spotlight, and first-run trigger"
```

---

### Task 4: Replay entry points, guide entry, verification, README, rebuild

**Files:**
- Modify: `src/renderer/src/keyboard/actions.ts` (a `wizard.start` action), `src/renderer/src/lib/guide.ts` (`GUIDE_CONCEPTS` entry), `src/renderer/src/components/FeaturesGuide.tsx` (only if the guide needs a click-to-start affordance — otherwise the palette action suffices), `README.md`

- [ ] **Step 1: Replay entries**

- In `keyboard/actions.ts` `buildActions`, add an action `{ id: "wizard.start", title: "Start tour", group: "App", run: () => <start the wizard> }` (no default keybinding). The wizard controller is a hook; expose a module-level starter it can call — e.g. the `useWizard` controller writes an ephemeral `start` into a tiny module singleton or a `useUi` field (`wizardStart`), and the action calls that. Match how other actions reach state; keep it simple (a `useUi` boolean like `tourRequested` that the mounted `<Wizard/>` watches and consumes is acceptable and avoids cross-module wiring).
- Ensure the Features Guide can trigger the same (a "Start the tour" row/button that sets `tourRequested`), so it's replayable from the guide as the spec promises.

- [ ] **Step 2: Guide entry**

In `lib/guide.ts`, add to `GUIDE_CONCEPTS`: `{ id: "concept:tour", title: "Guided tour", what: "A hands-on walkthrough that has you create an environment, tabs, a widget and open settings.", how: "It runs on first launch; replay it anytime from here or the command palette (Start tour)." }`.

- [ ] **Step 3: Full verification**

Run: `npm test` (exit code is the gate; re-run the two watcher files in isolation if they flake), `npm run typecheck`, and `npm run build`. All green.

- [ ] **Step 4: README**

In `README.md`'s "Beyond the port" section, add the onboarding wizard: an interactive first-run tour that has the user actually create an environment, add tabs and a widget, and open settings, with a spotlight and completion detection; replayable from the Features Guide and command palette.

- [ ] **Step 5: Rebuild the app**

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir 2>&1 | tail -15` — expected: `dist/mac-arm64/nodeDDD.app` rebuilt. Report the path.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/keyboard/actions.ts src/renderer/src/lib/guide.ts src/renderer/src/components/FeaturesGuide.tsx README.md
git commit -m "feat(wizard): replay entries, guide entry, and docs"
```
