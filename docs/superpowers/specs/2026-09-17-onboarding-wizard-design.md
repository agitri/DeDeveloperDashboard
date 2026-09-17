# Interactive "DO" Onboarding Wizard — Design

**Status:** approved for planning (2026-09-17)
**Author:** nodeDDD post-port UX phase, part 4

## Goal

A hands-on onboarding wizard that has the user *perform* real actions rather than read screenshots. Each step gives an instruction ("add a widget with ⌘⇧A — you try"), spotlights the real UI, detects when the user actually did it, rewards them (🎉), and advances. It auto-starts on a fresh install and can be replayed anytime. Flow: welcome → create an environment → tabs (add + switch) → add a widget → open settings → finish.

## Principles

- **A DO wizard, not a READ wizard.** It never blocks the app; the user interacts with the real board while the wizard coaches and watches.
- **Never a trap.** Every step has "Show me" (reveal the exact shortcut + intensify the spotlight), an auto-hint after ~15s stuck, "Skip step", and "Exit tour".
- **Detect the real outcome**, not the keystroke — a widget actually added, an environment actually created — by observing the store.

## Architecture

Renderer-led, with one small core addition for persistence.

**Core (persistence):**
- `Global` gains `wizard?: { completed: boolean; step?: number } | null` (parallel to `appearance`), added to `StoredGlobal`/`Global` and parsed in `globalFromJson` / defaulted in `defaultGlobal` (mirroring how `appearance` was added and migrated). `src/core/global.ts` gains `globalWizardSave(completed: boolean, step?: number)` (template: `globalAppearanceSave` at `global.ts:61-66`), exposed as command `global_wizard_save` (template: `global_appearance_save`) and `ipc.globalWizardSave` (template: `ipc.globalAppearanceSave` at `ipc.ts:376-383`). App-global, once per user (`~/.ddd/global.json`).

**Renderer:**
- `src/renderer/src/onboarding/steps.ts` (pure, tested): the ordered `WizardStep[]`. Each step: `{ id, title, instruction, shortcut?, target?: string (a data-wizard-target key), hint, done(baseline, current): boolean }`. `baseline`/`current` are a small `WizardSnapshot` (`{ envCount, tabCount, widgetCount, activeTabId, view }`) captured from the stores — so `done` is pure and unit-testable (e.g. "env step done when current.envCount > baseline.envCount"). Plus pure helpers `snapshotOf(...)` inputs and `progress(stepIndex, total)`.
- `src/renderer/src/onboarding/useWizard.ts`: the controller hook. Holds `{ active, stepIndex, baseline, showHint }`; subscribes to `useStore` and `useUi` (vanilla zustand `.subscribe`), builds a `WizardSnapshot` on each change, and when `step.done(baseline, current)` flips true → shows the reward, then advances (new baseline). `start()` (from first-run or replay), `skip()`, `exit()`, `showMe()`. Persists via `ipc.globalWizardSave` on finish/exit and on step advance (so a reload resumes at `step`). Starts a ~15s timer per step to auto-set `showHint`.
- `src/renderer/src/components/Spotlight.tsx`: given a `data-wizard-target` key, finds the element, reads `getBoundingClientRect()`, and renders a fixed cut-out (a transparent box sized to the rect with a large surrounding dim via `box-shadow: 0 0 0 9999px rgba(...)`, rounded), `pointer-events: none` so clicks reach the real element. Recomputes on scroll/resize and when the step changes; renders nothing (no dim) when the step has no target (keyboard-only steps still show the panel).
- `src/renderer/src/components/Wizard.tsx`: the coach panel (corner card: step title, instruction, the shortcut as a key glyph, progress "3/6", buttons Show me / Skip / Exit, and the 🎉 reward state) plus `<Spotlight>`. Renders nothing when `!active`. Mounts in the overlays fragment of `App.tsx` (`App.tsx:99-117`), alongside `WidgetPicker`/`FeaturesGuide`, so it floats above either shell.
- **Target hooks:** add `data-wizard-target` attributes to the stable elements — the New-tab button (`TabStrip.tsx:69` `.strip-add`), the environment area (`.env-tab`/`.env-name`, `TabStrip.tsx:236-248`), the settings gear (`App.tsx:171-182` and the console `ConsoleRail.tsx:109-112`), and the tab strip (`.strip`). The widget step is keyboard-driven (⌘⇧A); it spotlights the tab/board region and shows the shortcut.
- **Trigger:** on app ready, if `global.wizard` is absent or `!completed`, `start()` after the board first renders. **Replay:** a `wizard.start` action in `keyboard/actions.ts` `buildActions` (command palette entry "Start tour"; no default keybinding), and an entry in the Features Guide that calls `start()`.
- **Guide entry:** a `GUIDE_CONCEPTS` "Guided tour" entry in `lib/guide.ts` (the standing rule: new features update the guide).
- Styles for the spotlight + coach panel in `global.css` and `[data-look="console"]` overrides in `console.css`, existing tokens, no icon library.

## Detection (the crux)

`useStore.subscribe`/`useUi.subscribe` are vanilla (full-state listeners); the controller diffs the fields it needs into a `WizardSnapshot`:

| Step | done when |
|---|---|
| create environment | `current.envCount > baseline.envCount` |
| add a tab | `current.tabCount > baseline.tabCount` |
| switch tabs | `current.activeTabId !== baseline.activeTabId` |
| add a widget | `current.widgetCount > baseline.widgetCount` |
| open settings | `current.view === "settings"` |

`envCount = global.environments.length`; `tabCount = tabs().length`; `widgetCount = activeTab()?.widgets.length ?? 0`; `view` from the store. No new event kinds are required (the existing `tab.create`/`widget.add`/`view.settings` events are a bonus, not the mechanism). Optionally add an `env.create` `logEvent` in `createEnvironment` for parity, but detection does not depend on it.

## Errors and edge cases

- **Spotlight target missing** (element not mounted, wrong look): no dim/cut-out that frame; the coach panel still shows the instruction and shortcut, so the step is never blocked.
- **User already did the action** before reading (e.g. already has 2 environments): the baseline is captured at step start, so pre-existing state doesn't auto-complete; the step waits for a *new* action. (A "create an environment" step on a user who wants to skip uses Skip.)
- **Replay on a populated board**: works identically — baselines are relative, so the user adds one more of each.
- **Exit/skip**: persists `completed: true` on Exit-from-finish and on explicit "Finish"; "Skip step" just advances; "Exit tour" ends and marks completed so it won't auto-reappear (replayable from the guide).
- **Reload mid-tour**: `global.wizard.step` is persisted on advance, so a restart resumes at that step (or the user can exit).
- **Non-interactive/preview** (`!isNative`): `ipc.globalWizardSave` no-ops in the browser preview; the wizard still runs visually.

## Testing

- Core: `global`/`models` tests — `wizard` round-trips through `globalFromJson`/save and defaults correctly; a `global.json` without it still loads (backward-compat migration, like `appearance`).
- Renderer: `src/renderer/src/onboarding/steps.test.ts` — every step has a non-empty title/instruction and a `done` predicate; each `done` fires only on the intended baseline→current transition and not on unrelated changes; `progress` is correct; the step order matches the flow.
- `npm test` and `npm run typecheck` exit 0 (the two FSEvents watcher tests are a known environmental flake — judge by whether only those fail); `npm run build` clean.

## Delivery

- One spec (this file), one plan, subagent-driven with a final review and one fix wave, merged to main locally.
- The Features Guide gains the tour entry.
- **Final step: rebuild the app** (`npm run dist:dir`) so the wizard is runnable, per the standing preference. Note: to see the auto-first-run behaviour against a real board, the wizard keys off `global.wizard.completed`; testing the first-run path uses a scratch `DDD_HOME` (a fresh `~/.ddd`) so a developer's real board is untouched.
