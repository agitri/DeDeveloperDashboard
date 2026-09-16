# Features Guide and Promote-to-Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two renderer features to nodeDDD — a Features Guide modal (an accordion of what the app can do) and Promote-to-Tab (one click on a repo builds a pre-filled tab with a Launcher, a project-scoped Products widget, a read-only About widget, and Notes).

**Architecture:** Pure logic in `src/renderer/src/lib/*` with unit tests; thin components consume it. No `src/core` change, no new Electron command, no `~/.ddd` change — both features read through existing commands. A new optional `filter.projectId` scopes the Products and Projects widgets. A new `about` widget kind composes existing IPC.

**Tech Stack:** React 19, zustand, TypeScript 5.8, vitest 5 (node env). Renderer at `src/renderer/src/`.

**Spec:** `docs/superpowers/specs/2026-09-16-features-guide-and-promote-to-tab-design.md`

## Global Constraints

- Renderer-only. Do not touch `src/core`, `src/main`, `src/preload`, or any Electron command. This work deliberately ends the "renderer byte-identical to DDD" rule.
- Keep logic in pure functions under `lib/` and test them; components stay thin. This matches the port's discipline.
- Backward compatible with layouts already on disk: every new field is optional; a widget with no `projectId` and a layout with no `about` widget behave exactly as before.
- Both looks must be correct: base/classic tokens in `src/renderer/src/styles/global.css`, Console overrides scoped under `[data-look="console"]` in `src/renderer/src/styles/console.css`. No icon library; use CSS or text glyphs consistent with existing usage.
- `npm test` and `npm run typecheck` must exit 0 after every task. The exit code is the gate (the live FSEvents watcher tests may print a FAIL under load and still exit 0 via retry).
- No new npm dependency.
- Commit after every task. End every commit message with these two trailer lines exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`

### Verified facts (from the codebase, use these verbatim)

- `Widget` (`src/renderer/src/types/index.ts:32-48`): `{ id, kind, title?, connectionId?, filter: Record<string,unknown>, config: Record<string,unknown>, refreshSeconds?, layout: GridPos }`. `Tab` (`:57-63`): `{ id, name, color?, groupId?, widgets: Widget[] }`. `GridPos` (`:24-29`): `{ x, y, w, h }`. Grid is 12 columns (`src/renderer/src/state/grid.ts`, `GRID_COLS=12`).
- `Product` has a `projectId` field (`src/renderer/src/lib/products.ts` `byProject` groups on `product.projectId`). `Product.key` is `<projectId>/<productId>`.
- `Project` (`src/renderer/src/types/index.ts:143-155`): `{ id, path, name, exists, config, git, recap?, recapUpdatedAt?, todos, icmFiles }`. No `remote` field.
- IPC (`src/renderer/src/lib/ipc.ts`): `projectsList(env): Promise<Project[]>` (`:470`), `projectRegister(env, path): Promise<Project>` (`:475`), `productsList(env): Promise<Product[]>` (`:795`), `eventsQuery(env, { since?, kindPrefix?, limit? }): Promise<EventRow[]>` (`:558`, **no project param** — filter client-side), `projectLaunch(env, id)` (`:530`).
- `EventRow extends EventInput` (`types/index.ts:274-284`); `EventInput` has an optional `project` field.
- Store (`src/renderer/src/state/store.ts`): `uid(prefix)` (`:30`), `addTab(environmentId?)` (`:322`, the template for building+persisting+activating a tab — it calls `persistLayout(envId, next)` then `set({... activeTabId, overviewEnvId:null, view:"board"})` and `logEvent({kind:"tab.create"})`), `addWidget` (`:100`/`:546`), `activeEnvironmentId()` (`:235`). `persistLayout` (`:159`).
- UI store (`src/renderer/src/state/ui.ts`): flags `paletteOpen`/`pickerOpen` with `togglePalette(open?)`/`togglePicker(open?)` (`:60-63`) — the pattern to mirror for a guide flag.
- Command palette actions come from `buildActions` in `src/renderer/src/keyboard/actions.ts`, consumed by `src/renderer/src/components/CommandPalette.tsx:2`.
- Modal house pattern: `.scrim` backdrop + `.panel` with `onMouseDown` stop-propagation and `role="dialog"` (`CommandPalette.tsx:55-56`, `WidgetPicker.tsx`).
- Widget registry: `WIDGETS: WidgetDefinition[]` (`src/renderer/src/widgets/registry.tsx:65`); `WidgetDefinition` (`:33-63`): `{ kind, name, description, source, needsConnection?, defaultRefreshSeconds?, flush?, instructable?, menuItems?, View }`.
- The app entry component is `src/renderer/src/App.tsx` (renders the modals and header).
- Detail/prose idiom for read-only cards: `.item-detail.stack`, `.mono-label.caption`, `.ink-2`, inline `<code>` (see `IcmPanel` in `src/renderer/src/widgets/ItemsWidget.tsx:347-380`).

---

### Task 1: The `projectId` filter for Products and Projects

**Files:**
- Modify: `src/renderer/src/lib/products.ts`
- Modify: `src/renderer/src/widgets/ProductsWidget.tsx`
- Modify: `src/renderer/src/widgets/ProjectsWidget.tsx`
- Test: `src/renderer/src/lib/products.test.ts` (create if absent, else extend)

**Interfaces:**
- Produces: `filterByProject(products: Product[], projectId?: string): Product[]` — used by Task 4 (About) and relied on by the promoted Products widget.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/lib/products.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterByProject } from "./products";
import type { Product } from "../types";

function product(projectId: string, productId: string): Product {
  return {
    key: `${projectId}/${productId}`,
    projectId,
    productId,
    name: productId,
    run: "true",
    dir: "/tmp",
    dirExists: true,
    state: { state: "stopped" },
    log: "",
  } as Product;
}

describe("filterByProject", () => {
  const all = [product("a", "one"), product("b", "two"), product("a", "three")];
  it("keeps only the matching project, in order", () => {
    expect(filterByProject(all, "a").map((p) => p.productId)).toEqual(["one", "three"]);
  });
  it("is a no-op when the id is undefined", () => {
    expect(filterByProject(all, undefined)).toEqual(all);
  });
  it("returns nothing for an unknown project", () => {
    expect(filterByProject(all, "zzz")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/lib/products.test.ts` — expected: fails to import `filterByProject`.

- [ ] **Step 3: Implement `filterByProject`**

Add to `src/renderer/src/lib/products.ts` (near `byProject`):

```ts
/** Narrow a product list to one project, or pass it through when unscoped. */
export function filterByProject(products: Product[], projectId?: string): Product[] {
  if (!projectId) return products;
  return products.filter((p) => p.projectId === projectId);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/renderer/src/lib/products.test.ts` — expected: PASS.

- [ ] **Step 5: Apply the filter in the two widgets**

In `src/renderer/src/widgets/ProductsWidget.tsx`: import `filterByProject`, read the optional filter, and apply it before `byProject`. The widget receives its `widget` via `WidgetViewProps`; read `const projectId = typeof widget.filter.projectId === "string" ? widget.filter.projectId : undefined;` and change `const groups = byProject(products);` to `const groups = byProject(filterByProject(products, projectId));`. Nothing else changes; unscoped widgets keep every project.

In `src/renderer/src/widgets/ProjectsWidget.tsx`: read the same optional `projectId` from `widget.filter`, and when set, narrow the list the widget renders to the one project (`projects.filter((p) => p.id === projectId)`), leaving all other behaviour intact. Match the file's existing variable names and the exact place it maps over the project list.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/renderer/src/lib/products.test.ts` — expected: both clean.

```bash
git add src/renderer/src/lib/products.ts src/renderer/src/lib/products.test.ts src/renderer/src/widgets/ProductsWidget.tsx src/renderer/src/widgets/ProjectsWidget.tsx
git commit -m "feat(widgets): optional projectId filter for Products and Projects"
```

---

### Task 2: The guide content model and builder

**Files:**
- Create: `src/renderer/src/lib/guide.ts`
- Test: `src/renderer/src/lib/guide.test.ts`

**Interfaces:**
- Produces: `GuideEntry`, `GuideGroup`, `buildGuide(widgets: WidgetDefinition[]): GuideEntry[]`, and `GUIDE_INTEGRATIONS`/`GUIDE_CONCEPTS` (authored data). Task 3 renders these.

- [ ] **Step 1: Write the failing test**

`src/renderer/src/lib/guide.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildGuide } from "./guide";
import { WIDGETS } from "../widgets/registry";

describe("buildGuide", () => {
  const guide = buildGuide(WIDGETS);

  it("has an entry for every widget kind (drift guard)", () => {
    const widgetIds = new Set(guide.filter((e) => e.group === "widget").map((e) => e.id));
    for (const def of WIDGETS) expect(widgetIds.has(`widget:${def.kind}`)).toBe(true);
  });

  it("gives every entry a non-empty what and how", () => {
    for (const e of guide) {
      expect(e.what.trim().length).toBeGreaterThan(0);
      expect(e.how.trim().length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = guide.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all three groups", () => {
    const groups = new Set(guide.map((e) => e.group));
    expect(groups).toEqual(new Set(["widget", "integration", "concept"]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/lib/guide.test.ts` — expected: cannot resolve `./guide`.

- [ ] **Step 3: Write the module**

`src/renderer/src/lib/guide.ts`:

```ts
import type { WidgetDefinition } from "../widgets/registry";

export type GuideGroup = "widget" | "integration" | "concept";

export interface GuideEntry {
  id: string;
  group: GuideGroup;
  title: string;
  what: string; // one line: what it is
  how: string; // one line: how to use it
  needs?: string; // one line: what it depends on
}

/**
 * How-to lines per widget kind. The `what` comes from the registry description
 * so it cannot drift; the how is authored here. buildGuide asserts every kind
 * has a line, so a newly registered widget forces a guide row rather than
 * shipping without one.
 */
const WIDGET_HOW: Record<string, { how: string; needs?: string }> = {
  clock: { how: "Add it from the + menu; it needs no setup." },
  notes: { how: "Add it and type; the text is saved in your layout." },
  calendar: { how: "Add it, then subscribe to .ics feeds in Settings to fill it." },
  launcher: { how: "Add it and set targets — a directory and whether to open a terminal or your editor." },
  items: { how: "Add it, bind a connection, and give it a filter (or describe one in words).", needs: "A connection (GitHub, Jira, Slack, mail, MCP…)." },
  stats: { how: "Add it; it reads your local activity, no connection needed." },
  projects: { how: "Register a project folder; it shows git status, todos, recap and .ddd/icm count.", needs: "A folder with a .ddd/ directory." },
  devservers: { how: "Add it; it scans what is listening on this machine." },
  products: { how: "Declare products in a repo's .ddd/config.json, then approve a command once to start it.", needs: "A project with declared products and one-time run approval." },
  eol: { how: "Assign a checkout to watch; it checks weekly whether its runtimes are still supported." },
  repos: { how: "Bind a GitHub connection to list your repos, or add a local checkout by path.", needs: "A GitHub connection for remotes; local scan works without one." },
  about: { how: "Created for you by Promote to tab; shows one repo's facts and recent activity." },
};

export interface GuideStatic {
  id: string;
  title: string;
  what: string;
  how: string;
  needs?: string;
}

export const GUIDE_INTEGRATIONS: GuideStatic[] = [
  { id: "integration:github", title: "GitHub", what: "Your pull requests, issues and repositories.", how: "Add a GitHub connection in Settings → Connections with a token.", needs: "A GitHub personal access token." },
  { id: "integration:jira", title: "Jira", what: "Your Jira issues as items.", how: "Add a Jira connection with your site, email and API token.", needs: "A Jira API token." },
  { id: "integration:slack", title: "Slack", what: "Messages and mentions from Slack.", how: "Add a Slack connection and authorise the requested scopes.", needs: "A Slack token with history scopes." },
  { id: "integration:google", title: "Google (Gmail + Calendar)", what: "Mail as items and events in the calendar.", how: "Add a Google connection and sign in.", needs: "A Google OAuth sign-in." },
  { id: "integration:imap", title: "IMAP mail", what: "Any mailbox over IMAP as items.", how: "Add an IMAP connection with host, user and an app password.", needs: "IMAP host and an app password." },
  { id: "integration:mcp", title: "MCP", what: "Tools and resources from a Model Context Protocol server, shown as items.", how: "Add an MCP connection (stdio command or HTTP endpoint) and approve it once.", needs: "An MCP server command or endpoint, plus one-time consent." },
];

export const GUIDE_CONCEPTS: GuideStatic[] = [
  { id: "concept:mcp", title: "MCP connections", what: "How external tool servers plug in as a source for the Items widget.", how: "Configure one in Settings → Connections; consent binds the exact command." },
  { id: "concept:icm", title: "ICM context files", what: "The .ddd/icm/ files in a project that shape what an AI action is given.", how: "Put files in a project's .ddd/icm/; the Projects and Items widgets show what will be used." },
  { id: "concept:ai", title: "AI routing", what: "Which model answers each AI action — local Ollama or Anthropic.", how: "Set an Ollama URL or an Anthropic key in Settings → AI; actions default to local where they can." },
  { id: "concept:looks", title: "Looks", what: "Two visual treatments of the whole app: classic and console.", how: "Choose a look; it is remembered across launches." },
  { id: "concept:approval", title: "Run approval", what: "Why starting a product needs a one-time consent.", how: "Approve the exact command and directory once; a checkout can declare a command but never auto-run it." },
];

export function buildGuide(widgets: WidgetDefinition[]): GuideEntry[] {
  const widgetEntries: GuideEntry[] = widgets.map((def) => {
    const hint = WIDGET_HOW[def.kind];
    return {
      id: `widget:${def.kind}`,
      group: "widget",
      title: def.name,
      what: def.description,
      how: hint?.how ?? def.description,
      needs: hint?.needs ?? (def.needsConnection ? "A connection." : undefined),
    };
  });
  const toEntry = (group: GuideGroup) => (s: GuideStatic): GuideEntry => ({ ...s, group });
  return [
    ...widgetEntries,
    ...GUIDE_INTEGRATIONS.map(toEntry("integration")),
    ...GUIDE_CONCEPTS.map(toEntry("concept")),
  ];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/renderer/src/lib/guide.test.ts` — expected: PASS. If the drift guard fails, a widget kind is missing from `WIDGET_HOW` — add its line (do not weaken the test). Note: the `about` kind is registered in Task 4; until then `WIDGET_HOW.about` simply has no matching widget, which is fine.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/guide.ts src/renderer/src/lib/guide.test.ts
git commit -m "feat(guide): content model and builder for the features guide"
```

---

### Task 3: The Features Guide modal and its entry points

**Files:**
- Create: `src/renderer/src/components/FeaturesGuide.tsx`
- Modify: `src/renderer/src/state/ui.ts` (add `guideOpen` + `toggleGuide`)
- Modify: `src/renderer/src/keyboard/actions.ts` (add an "Open guide" action)
- Modify: `src/renderer/src/App.tsx` (render the modal; add a header button)
- Modify: `src/renderer/src/styles/global.css` and `src/renderer/src/styles/console.css` (accordion primitives)

**Interfaces:**
- Consumes: `buildGuide` (Task 2).

- [ ] **Step 1: Add the UI flag**

In `src/renderer/src/state/ui.ts`, mirror the `pickerOpen`/`togglePicker` pattern exactly: add `guideOpen: boolean` to `UiState`, initialise it `false`, and add `toggleGuide(open?: boolean): void` implemented as `set((s) => ({ guideOpen: open ?? !s.guideOpen, paletteOpen: false, pickerOpen: false }))`. Also set `guideOpen: false` inside `togglePalette` and `togglePicker` so the three overlays are mutually exclusive (match how they already clear each other).

- [ ] **Step 2: Build the modal**

`src/renderer/src/components/FeaturesGuide.tsx` — a modal using the house pattern (`.scrim` + `.panel`, `role="dialog"`, backdrop click and Escape close via `toggleGuide(false)`). Body: the three groups (Widgets, Integrations, Concepts) as labelled sections; within each, one row per `GuideEntry`. Single-open accordion via `const [openId, setOpenId] = useState<string | null>(null)`; a row header is a `<button>` with `aria-expanded={openId === e.id}` and `aria-controls`; clicking sets `openId` to that id, or `null` if it was already open. The open row reveals `what`, `how` (and `needs` when present) in the detail idiom (`.item-detail.stack`, `.mono-label.caption`, `.ink-2`). Compute entries once with `useMemo(() => buildGuide(WIDGETS), [])`. Render nothing when `!guideOpen`.

- [ ] **Step 3: Wire the entry points**

In `src/renderer/src/App.tsx`: render `<FeaturesGuide />` alongside the other overlays (`CommandPalette`, `WidgetPicker`), and add a header button (match the existing `.icon-btn` header controls) with `title="Features guide"` that calls `useUi.getState().toggleGuide()` (or the hook form the file uses). In `src/renderer/src/keyboard/actions.ts`, add an action to `buildActions` — label "Features guide" (or "Open guide") — whose run calls `toggleGuide(true)`, following the exact shape of the existing actions in that file (read it and match the `Action` type and how each action reaches the UI store).

- [ ] **Step 4: Style the accordion (both looks)**

In the "widget primitives" block of `src/renderer/src/styles/global.css`, add classes for `.guide-row` (the header button: full width, left-aligned, chevron on the right), `.guide-chevron` (a CSS triangle or text glyph that rotates when its row is open), and `.guide-detail` (the revealed body). Use existing tokens (`--ink-2`, spacing vars) so it matches. Add any needed override in `src/renderer/src/styles/console.css` under `[data-look="console"]` so the guide reads correctly in the console look. Verify visually against both looks is not possible here; keep the CSS to existing tokens and the shared primitives so it inherits correctly.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck` — expected: clean. Run: `npx vitest run` for any touched test files (none new here) and confirm `npm test` stays green.

```bash
git add src/renderer/src/components/FeaturesGuide.tsx src/renderer/src/state/ui.ts src/renderer/src/keyboard/actions.ts src/renderer/src/App.tsx src/renderer/src/styles/global.css src/renderer/src/styles/console.css
git commit -m "feat(guide): the features guide modal, header button and command"
```

---

### Task 4: The About widget

**Files:**
- Create: `src/renderer/src/widgets/AboutWidget.tsx`
- Modify: `src/renderer/src/widgets/registry.tsx` (register `about`)
- Test: none new (composition of existing IPC; logic is covered by Task 1's `filterByProject` and Task 5's builder). Keep the component thin.

**Interfaces:**
- Consumes: `filterByProject` (Task 1), `ipc.projectsList`, `ipc.productsList`, `ipc.eventsQuery`.
- Produces: the `about` widget kind, config `{ projectId: string; name?: string; path?: string; remote?: string }`.

- [ ] **Step 1: Build the widget**

`src/renderer/src/widgets/AboutWidget.tsx` — a read-only card following an existing widget's `WidgetViewProps` signature (read `ProjectsWidget.tsx` for the exact prop shape and how it gets `environmentId`). Read `const projectId = String(widget.config.projectId ?? "")`. Load, on mount and on the environment's data:
- the project from `ipc.projectsList(environmentId)` (find by `id === projectId`) for name, path, git status, todos count, `icmFiles.length`;
- its products via `filterByProject(await ipc.productsList(environmentId), projectId)`;
- recent jobs via `ipc.eventsQuery(environmentId, { limit: 50 })` then `.filter((e) => e.project === projectId).slice(0, 8)` (client-side; the query has no project param).

Render name, `<code>` path, remote (from `widget.config.remote`, only if present), a declared-products count/list, and the recent jobs newest first (kind + relative time; reuse `since` from `lib/products` for the relative time if useful). Empty states: "project not found" when the project id matches nothing; "no recent activity" when the filtered events are empty. Use the detail idiom classes. Do not add write actions.

- [ ] **Step 2: Register the kind**

In `src/renderer/src/widgets/registry.tsx`, add to `WIDGETS`:

```tsx
{
  kind: "about",
  name: "About",
  description: "One repo at a glance: its facts, declared products and recent activity.",
  source: "local",
  needsConnection: false,
  flush: true,
  View: AboutWidget,
},
```

Import `AboutWidget` at the top with the other widget imports. Do **not** add it to `PRESETS` (it is created by Promote to tab, not the + menu).

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/renderer/src/lib/guide.test.ts` — expected: clean, and the guide drift guard now also passes for `about` (its `WIDGET_HOW.about` line already exists from Task 2).

```bash
git add src/renderer/src/widgets/AboutWidget.tsx src/renderer/src/widgets/registry.tsx
git commit -m "feat(widgets): read-only About widget for one project"
```

---

### Task 5: Promote to tab — builder, action, and buttons

**Files:**
- Create: `src/renderer/src/lib/promote.ts`
- Test: `src/renderer/src/lib/promote.test.ts`
- Modify: `src/renderer/src/state/store.ts` (add `promoteToTab`)
- Modify: `src/renderer/src/widgets/RepoWidget.tsx` (row action)
- Modify: `src/renderer/src/widgets/ProjectsWidget.tsx` (row action)

**Interfaces:**
- Consumes: `uid` (store), `ipc.projectRegister`, the `about` kind (Task 4), the Products `projectId` filter (Task 1).
- Produces: `buildPromotedTab(input, mintId): Tab`; `store.promoteToTab(input)`.

- [ ] **Step 1: Write the failing test**

`src/renderer/src/lib/promote.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPromotedTab } from "./promote";

describe("buildPromotedTab", () => {
  let n = 0;
  const mint = (p: string) => `${p}-${n++}`;
  const tab = buildPromotedTab(
    { projectId: "proj1", name: "acme", path: "/repos/acme", remote: "github.com/acme/acme" },
    mint,
  );

  it("names the tab for the repo", () => {
    expect(tab.name).toBe("acme");
  });

  it("holds exactly launcher, products, about and notes", () => {
    expect(tab.widgets.map((w) => w.kind).sort()).toEqual(["about", "launcher", "notes", "products"]);
  });

  it("gives the Launcher a terminal and an editor target for the path", () => {
    const launcher = tab.widgets.find((w) => w.kind === "launcher")!;
    const targets = launcher.config.targets as { path: string; open: string }[];
    expect(targets.map((t) => t.open).sort()).toEqual(["ide", "terminal"]);
    expect(targets.every((t) => t.path === "/repos/acme")).toBe(true);
  });

  it("scopes Products and About to the project", () => {
    const products = tab.widgets.find((w) => w.kind === "products")!;
    const about = tab.widgets.find((w) => w.kind === "about")!;
    expect(products.filter.projectId).toBe("proj1");
    expect(about.config.projectId).toBe("proj1");
    expect(about.config.remote).toBe("github.com/acme/acme");
  });

  it("mints unique ids and lays widgets out without overlap", () => {
    const ids = tab.widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    // no two widgets share the same top-left cell
    const cells = tab.widgets.map((w) => `${w.layout.x},${w.layout.y}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/lib/promote.test.ts` — expected: cannot resolve `./promote`.

- [ ] **Step 3: Write the builder**

`src/renderer/src/lib/promote.ts`:

```ts
import type { Tab, Widget } from "../types";

export interface PromoteInput {
  projectId: string;
  name: string;
  path: string;
  remote?: string;
}

/** Build a tab pre-filled for one repo. Pure: the store supplies the id minter. */
export function buildPromotedTab(input: PromoteInput, mintId: (prefix: string) => string): Tab {
  const widget = (
    kind: string,
    layout: Widget["layout"],
    extra: { title?: string; filter?: Record<string, unknown>; config?: Record<string, unknown> },
  ): Widget => ({
    id: mintId("w"),
    kind,
    title: extra.title ?? null,
    connectionId: null,
    filter: extra.filter ?? {},
    config: extra.config ?? {},
    refreshSeconds: null,
    layout,
  });

  const launcher = widget("launcher", { x: 0, y: 0, w: 4, h: 4 }, {
    title: input.name,
    config: {
      targets: [
        { id: mintId("t"), label: "Terminal", path: input.path, open: "terminal" },
        { id: mintId("t"), label: "Editor", path: input.path, open: "ide" },
      ],
    },
  });
  const about = widget("about", { x: 4, y: 0, w: 8, h: 4 }, {
    title: input.name,
    config: { projectId: input.projectId, name: input.name, path: input.path, remote: input.remote },
  });
  const products = widget("products", { x: 0, y: 4, w: 6, h: 6 }, {
    filter: { projectId: input.projectId },
  });
  const notes = widget("notes", { x: 6, y: 4, w: 6, h: 6 }, { config: { text: "" } });

  return {
    id: mintId("tab"),
    name: input.name,
    color: null,
    groupId: null,
    widgets: [launcher, about, products, notes],
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/renderer/src/lib/promote.test.ts` — expected: PASS.

- [ ] **Step 5: Add the store action**

In `src/renderer/src/state/store.ts`, add `promoteToTab(input: { environmentId?: string; path: string; name: string; remote?: string }): Promise<void>` to the store type and implementation. Model it on `addTab` (`:322`) but async:

1. `const envId = input.environmentId ?? get().activeEnvironmentId();`
2. `const project = await ipc.projectRegister(envId, input.path);` (idempotent; gives the `projectId`).
3. `const tab = buildPromotedTab({ projectId: project.id, name: input.name, path: input.path, remote: input.remote }, uid);`
4. Append and persist exactly as `addTab` does: read `s.layouts[envId] ?? { version:1, groups:[], tabs:[] }`, `next = { ...layout, tabs: [...layout.tabs, tab] }`, `persistLayout(envId, next)`, and `set` with `layouts`, `activeTabId: tab.id`, `overviewEnvId: null`, `view: "board"`.
5. `get().logEvent({ kind: "tab.promote", project: project.id });`

Import `buildPromotedTab` and `ipc` following the file's existing imports (the store already imports `ipc` for `persistLayout`/other actions — reuse it).

- [ ] **Step 6: Add the row buttons**

In `src/renderer/src/widgets/RepoWidget.tsx`: on each repo row, add a compact "Promote to tab" control (a `.btn.sm` or the row's existing action style). Enable it only when the row has a known local path (the same local-checkout signal the row already uses for `registerLocal`, `:263-271`); when there is no local path, render it disabled with `title="check out or add a local path first"`. On click, call the store `promoteToTab({ path, name, remote })` using that row's path, a sensible name (repo name), and its remote.

In `src/renderer/src/widgets/ProjectsWidget.tsx`: on each project row, add the same control (always enabled — a project always has a path). On click, call `promoteToTab({ path: project.path, name: project.name })` (no remote from a project row).

Match each file's existing row-action markup and how it reaches the store (hook or `useStore.getState()`).

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/renderer/src/lib/promote.test.ts src/renderer/src/lib/products.test.ts src/renderer/src/lib/guide.test.ts` — expected: clean.

```bash
git add src/renderer/src/lib/promote.ts src/renderer/src/lib/promote.test.ts src/renderer/src/state/store.ts src/renderer/src/widgets/RepoWidget.tsx src/renderer/src/widgets/ProjectsWidget.tsx
git commit -m "feat(promote): build a pre-filled tab from a repo or project"
```

---

### Task 6: Full verification and README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full suite and typecheck**

Run: `npm test` and `npm run typecheck` — expected: exit 0 (the watcher tests may print a FAIL and still exit 0 via retry; the exit code is the gate). Run: `npm run build` — expected: the renderer builds with no type or bundling error (this is the closest thing to end-to-end for renderer-only work; there is no main-process smoke for these features).

- [ ] **Step 2: README**

Add a short "Beyond the port" note to `README.md`: the Features Guide (a modal listing widgets, integrations and concepts, reachable from the header and the command palette) and Promote to tab (one click on a repo or project builds a pre-filled tab with a Launcher, a project-scoped Products widget, an About card and Notes). Note that these are the first renderer features to diverge from DDD.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): features guide and promote-to-tab"
```
