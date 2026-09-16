# Features Guide and Promote-to-Tab — Design

**Status:** approved for planning (2026-09-16)
**Author:** nodeDDD post-port UX phase, part 1
**Depends on:** the completed port (main at `9a2f8d7`, all 71 commands)

## Goal

Two new renderer features for nodeDDD:

1. **Features guide** — a modal that lists everything the app can do (widgets, integrations, concepts) as an accordion. Each row folds open to a one-line "what it is" and a one-line "how to use it." Opening a row collapses whichever was open. It is the discoverable seed of the later onboarding wizard.
2. **Promote to tab** — a one-click action on a repo (in the Repositories or Projects widget) that builds a new tab pre-filled for that repo: a Launcher pointing at the checkout, a Products widget scoped to that project, a read-only About widget, and a Notes widget.

Both are new frontend work. They deliberately end the "renderer stays byte-identical to DDD" rule that held through the port; from here the nodeDDD renderer diverges on purpose.

## Non-goals

- No first-run wizard flow yet. The guide is reachable on demand; wiring it as onboarding is a later phase.
- No per-tab history/sitrep engine yet. The About widget shows recent jobs from the existing events log; the two-week-away greeting and local-AI summary are a later phase. About is the seed, not that feature.
- No icon set, no focus mode, no visual/colour pass. Those are separate post-port items.
- No change to the on-disk `~/.ddd` layout or to the shared command surface that both apps depend on. Both features read through commands that already exist.

## Architecture

Everything lives in the renderer (`src/renderer/src/`). The two features share one principle carried over from the port: **logic goes in pure, testable functions under `lib/`; components stay thin.**

New files:

- `src/renderer/src/components/FeaturesGuide.tsx` — the guide modal and its accordion.
- `src/renderer/src/lib/guide.ts` — the guide content model and its builder (pure).
- `src/renderer/src/widgets/AboutWidget.tsx` — the new read-only About widget.
- `src/renderer/src/lib/promote.ts` — `buildPromotedTab(...)`, the pure tab-builder.
- `src/renderer/src/lib/guide.test.ts`, `src/renderer/src/lib/promote.test.ts` — unit tests for the pure logic.

Modified files:

- `src/renderer/src/widgets/registry.tsx` — register the `about` widget kind.
- `src/renderer/src/widgets/ProductsWidget.tsx` and `src/renderer/src/lib/products.ts` — honour an optional `filter.projectId`.
- `src/renderer/src/widgets/ProjectsWidget.tsx` — honour an optional `filter.projectId`.
- `src/renderer/src/widgets/RepoWidget.tsx` and `src/renderer/src/widgets/ProjectsWidget.tsx` — the "Promote to tab" row action.
- `src/renderer/src/state/store.ts` — a `promoteToTab` action.
- `src/renderer/src/components/App.tsx` — a header button that opens the guide.
- `src/renderer/src/components/CommandPalette.tsx` — an "Open guide" command.
- `src/renderer/src/styles/global.css` and `src/renderer/src/styles/console.css` — accordion and About primitives, for both looks.
- `src/renderer/src/types/index.ts` — the About widget config type and the optional `projectId` filter field.

No new Electron command and no `src/core` change is required. If a tested core aggregator is preferred for About's data over composing existing IPC in the renderer, that is a self-contained option (see "About widget"), but the default is renderer composition.

## Feature A — Features guide

### Content model (`lib/guide.ts`)

```ts
export type GuideGroup = "widget" | "integration" | "concept"

export interface GuideEntry {
  id: string          // stable, unique (e.g. "widget:items", "integration:mcp")
  group: GuideGroup
  title: string       // display name
  what: string        // one line: what it is
  how: string         // one line: how to use it
  needs?: string      // one line: what it depends on, when non-trivial
}
```

A pure builder assembles the list so it cannot drift from the real app:

```ts
export function buildGuide(
  widgets: WidgetDefinition[],           // from registry WIDGETS
  connections: ConnectionKind[],         // from the Settings connection defs
): GuideEntry[]
```

- **Widget rows** come from `WIDGETS` (`registry.tsx`): `title` from `def.name`, `what` from `def.description`, `needs` derived from `def.needsConnection` (and known specifics such as Products needing a `.ddd/config.json` and run approval). The `how` line is authored per widget in a small table keyed by `def.kind`; the builder asserts every widget kind has a `how` entry so a newly added widget can't silently miss its guide row (this assertion is the core of `guide.test.ts`).
- **Integration rows** come from the connection kinds shown in Settings (GitHub, Jira, Slack, Google, IMAP, MCP): `what` and `how` authored, `needs` naming the secret/token each requires.
- **Concept rows** are authored: MCP (external tools/resources over a consented connection), ICM (the `.ddd/icm/` files that shape AI context), AI routing (local Ollama vs Anthropic key, per action), Looks (classic vs console), and Run approval (why a product needs one-time consent).

Authored `how`/`what`/`needs` text is short and reads from code facts where they exist (a connection's required field, a widget's `needsConnection`) rather than restating prose.

### The modal (`FeaturesGuide.tsx`)

- Rendered with the house modal pattern: a `.scrim` backdrop and a `.panel` container, matching `WidgetPicker`/`CommandPalette`. Escape and backdrop click close it; focus is trapped while open.
- Body is the accordion. Groups render as labelled sections (Widgets, Integrations, Concepts). Each entry is a button row showing the title and a chevron; the open row reveals `what`, `how`, and `needs` beneath it.
- **Single-open behaviour**: one piece of state holds the open entry id (`useState<string | null>`). Opening a row sets it; opening another replaces it; clicking the open row toggles it closed. This is the explicit requirement — only one row is open at a time.
- Accessibility: each header is a real `<button>` with `aria-expanded` and `aria-controls`; the panel has `role="region"`. Chevron rotates via CSS on the expanded state.
- Styling adds a small set of primitives to the "widget primitives" block in `global.css` (a `.guide-row`, `.guide-chevron`, `.guide-detail`) with `console.css` overrides so both looks are correct. No icon library; the chevron is a CSS triangle or a text glyph consistent with existing glyph usage.

### Opening it

- A header button in `App.tsx` (next to the existing chrome controls) toggles a `guideOpen` UI flag.
- A `CommandPalette` entry ("Open guide" / "Features guide") toggles the same flag, so it is reachable by keyboard.

### Errors and edge cases

The guide is static content; there is no fetch to fail. The builder's assertion (every widget kind has a `how`) fails loudly in tests, never at runtime — at runtime a missing `how` falls back to the widget's description so a row is never blank.

## Feature B — Promote to tab

### The action

A compact "Promote to tab" control on each repo row in `RepoWidget` and each project row in `ProjectsWidget`.

- **Enabled only when a local checkout path is known.** A remote-only GitHub repo with no local clone disables the control with a tooltip ("check out or add a local path first"). Projects always have a path, so the Projects-widget action is always enabled.
- On click, the store action `promoteToTab({ environmentId, path, name, remote? })` runs.

### The store action (`store.ts`) and builder (`lib/promote.ts`)

The store action is the thin wiring; the tab shape is a pure function so it can be tested without a store or DOM.

```ts
// lib/promote.ts — pure
export interface PromoteInput {
  projectId: string
  name: string          // tab + widget titles
  path: string          // local checkout
  remote?: string
}
export function buildPromotedTab(input: PromoteInput, mintId: (p: string) => string): Tab
```

`buildPromotedTab` returns a `Tab` (`types/index.ts`) with `widgets` laid out on the 12-column grid:

- **Launcher** — `config.targets` set to two `LaunchTarget`s for `input.path`: one `open: "terminal"`, one `open: "ide"`, labelled "Terminal" and "Editor".
- **Products** — `filter.projectId = input.projectId`, so it shows only this project's products.
- **About** — `kind: "about"`, `config: { projectId, name, path, remote }`.
- **Notes** — empty `config.text`.

Grid placement: Launcher and About on the top row, Products and Notes below, each sized from the grid presets so nothing overlaps.

The store action:

1. Ensures the path is registered as a project via `ipc.projectRegister(environmentId, path)` (idempotent — registration keys on canonical path). It uses the returned/looked-up `projectId`.
2. Calls `buildPromotedTab`, using the store's id minter.
3. Appends the tab to the environment's layout and persists it (the same path `addTab` uses), then sets it active.

Registration reuses the existing `projects.register` path, so the repo↔path link and product resolution behave exactly as they do when a user registers from the Repos widget today.

### Per-widget project filter

A new optional `projectId` on a widget's `filter`:

- **`ProductsWidget`** reads `widget.filter.projectId`. When set, it keeps only that project's group; the pure filtering moves into `lib/products.ts` as `filterByProject(products, projectId)` (tested there). When unset, behaviour is unchanged (all projects).
- **`ProjectsWidget`** reads `widget.filter.projectId`. When set, it lists only that project. When unset, unchanged.
- The field is optional and additive; every existing widget with no `projectId` behaves as before. This keeps the change backward-compatible with layouts already on disk.

### The About widget (`AboutWidget.tsx`)

A read-only card bound to one project, built from commands that already exist:

- **Facts**: name, local path, and (if known) remote. Git status, recap/todo counts, and `.ddd/icm/` file count come from the project's entry in `ipc.projectsList(environmentId)` (the same `Project` shape the Projects widget renders).
- **Declared products**: from `ipc.productsList(environmentId)` filtered to this `projectId` (reusing `filterByProject`).
- **Recent jobs**: recent rows from `ipc.eventsQuery(...)`, filtered to this project (client-side if the query has no project parameter). "Jobs" = the `item.*`, `ai.*`, and `project.*` events already logged, shown newest first, a handful at a time.
- Rendered in the existing detail idiom (`.item-detail.stack`, `.mono-label.caption`, `.ink-2`, inline `<code>` for paths), so it matches house style in both looks.
- Registered in `WIDGETS` (`registry.tsx`) with `source: "local"`, `needsConnection: false`, and a description. It is not added to the Widget Picker presets by default — it is created by promote — but registering the kind lets it render and lets a user keep it.

### Errors and edge cases

- **Unregistered/removed project**: About shows a compact "project not found" empty state rather than throwing; the rest of the tab still works.
- **No products declared**: About and the Products widget show their normal empty states.
- **No recent events**: About shows "no recent activity."
- **Promote creating a duplicate**: tabs are not unique by name; promoting the same repo twice makes a second tab. That is acceptable and cheap to delete; no dedupe logic.
- **Registration failure** (path gone): the action surfaces the error the same way other store actions do and does not create a half-built tab.

## Data flow

```
Repos/Projects row  --promoteToTab-->  store action
    store action: ipc.projectRegister(env, path) -> projectId
                  buildPromotedTab(input, mintId) -> Tab   (pure)
                  append tab to layout, persist, setActive
    new tab renders:
       Launcher(config.targets)         -> launchIn (existing)
       Products(filter.projectId)       -> ipc.productsList + filterByProject
       About(config.projectId)          -> ipc.projectsList + productsList + eventsQuery
       Notes(config.text)               -> layout only

Header button / command palette -> guideOpen flag -> FeaturesGuide
    FeaturesGuide: buildGuide(WIDGETS, connectionKinds) -> GuideEntry[]  (pure)
                   accordion: openId state, single open
```

## Testing

- `lib/guide.test.ts`: `buildGuide` returns an entry for every widget kind in `WIDGETS` (the drift guard), every entry has non-empty `what` and `how`, ids are unique, and the three groups are all present.
- `lib/promote.test.ts`: `buildPromotedTab` produces a tab with exactly the four expected widget kinds, the Launcher has two targets for the given path (one terminal, one ide), the Products and About widgets carry the given `projectId`, ids are minted uniquely, and grid positions do not overlap.
- `lib/products.test.ts` (extend or add): `filterByProject` keeps only the matching project and is a no-op when the id is undefined.
- Component behaviour (single-open accordion, modal open/close, promote enable/disable) is covered by the pure logic plus manual verification; no new renderer test harness is introduced beyond the existing vitest setup, matching the port's testing footprint.
- The full suite (`npm test`) and `npm run typecheck` must stay green. The merge gate is the exit code, as in the port.

## Delivery

- One spec (this file), one implementation plan, executed subagent-driven on a feature branch, with a final whole-branch review and one fix wave, then merged to main locally — the same workflow every port phase used.
- Memory is updated at merge: the renderer-diff-byte-identical rule has ended, and this part of the post-port UX phase is done.
