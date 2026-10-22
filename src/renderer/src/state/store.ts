// One store for the whole board.
//
// The shape worth understanding: tabs from *every* environment are held at once
// and rendered in a single strip, because environments surface as tab groups
// rather than as a profile you switch into (§5.9). The wall is in the data
// layer — a tab always knows which environment it belongs to, and widgets can
// only ever bind to that environment's connections — while the door is just a
// tab click.

import { create } from "zustand";
import { ipc, DEFAULT_APPEARANCE, DEFAULT_SETTINGS } from "../lib/ipc";
import { buildPromotedTab } from "../lib/promote";
import { packWidgets } from "./arrange";
import { exportLayout, importLayout } from "./portable";
import { switchStarted } from "./timing";
import { moveGroup, moveTab, setTabGroup as setTabGroupIn } from "./tabOrder";
import { GRID_COLS } from "./grid";
import type {
  AppearanceSettings,
  EnvTab,
  Environment,
  EventInput,
  Global,
  ItemFilter,
  Layout,
  RepoFilter,
  Settings,
  Widget,
} from "../types";

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

interface Store {
  ready: boolean;
  global: Global | null;
  /** Layout per environment id. */
  layouts: Record<string, Layout>;
  /** Settings per environment id. */
  settings: Record<string, Settings>;
  activeTabId: string | null;
  /** The tab you last had in each environment. Session-only; see `selectTab`. */
  lastTabByEnv: Record<string, string>;
  /**
   * When set, the board shows that environment's overview instead of a tab.
   *
   * `activeTabId` is deliberately left alone: it remembers where you were, so
   * leaving the overview does not have to guess. Everything that asks "which
   * tab is showing" must check this first.
   */
  overviewEnvId: string | null;
  /** Which route the shell is showing. */
  view: "board" | "settings";

  load(): Promise<void>;

  environments(): Environment[];
  /** Visible tabs in strip order, each tagged with its environment. */
  tabs(): EnvTab[];
  activeTab(): EnvTab | null;
  activeEnvironmentId(): string;
  activeSettings(): Settings;

  setView(view: "board" | "settings"): void;
  selectTab(tabId: string): void;
  selectTabByIndex(index: number): void;
  /** Unfold an environment and land on the tab you last used there. */
  activateEnvironment(envId: string): void;
  cycleTab(delta: number): void;

  addTab(environmentId?: string): void;
  /** Build a tab pre-filled for one repo or project, registering it first. */
  promoteToTab(input: { environmentId?: string; path: string; name: string; remote?: string }): Promise<void>;
  renameTab(tabId: string, name: string): void;
  /** Show one environment's overview instead of a tab. */
  showOverview(envId: string): void;
  /** Fold an environment's tabs away in the strip, or unfold them. */
  setEnvironmentCollapsed(envId: string, collapsed: boolean): void;
  /**
   * Reorder within one environment. `toIndex` is a boundary in that env's tabs.
   * `groupId` is the drop's own answer about group membership — omit it to let
   * the ordering module infer from neighbours.
   */
  moveTabTo(tabId: string, toIndex: number, groupId?: string | null): void;
  /** Reorder a group as a unit. `toIndex` is a boundary, as in `moveTabTo`. */
  moveGroupTo(envId: string, groupId: string, toIndex: number): void;
  /** A layout document for an environment, or for one tab of it. */
  exportTabs(envId: string, tabIds?: string[]): string;
  /** Add a document's tabs to an environment. Returns how many arrived. */
  importTabs(envId: string, document: string): number;
  setTabGroup(tabId: string, groupId: string | null): void;
  /** New group holding one tab, coloured like it. Returns nothing; the tab moves. */
  createGroup(tabId: string, name: string): void;
  renameGroup(envId: string, groupId: string, name: string): void;
  setGroupCollapsed(envId: string, groupId: string, collapsed: boolean): void;
  /** Release the tabs, keep them where they are, drop the group. */
  ungroup(envId: string, groupId: string): void;
  /** `null` clears the override so the tab follows its environment again. */
  setTabColor(tabId: string, color: string | null): void;
  closeTab(tabId: string): void;

  addWidget(
    kind: string,
    // `ItemFilter` for `items` presets, `RepoFilter` for `repos` presets. A
    // plain union, not `& Record<string, unknown>` — an index signature here
    // would suppress excess-property checking on every caller's filter
    // literal, including `items` ones, hiding typos like `sorce` instead of
    // rejecting them.
    options?: {
      filter?: ItemFilter | RepoFilter;
      title?: string;
      config?: Record<string, unknown>;
    },
  ): void;
  removeWidget(widgetId: string): void;
  updateWidgetLayout(updates: { id: string; x: number; y: number; w: number; h: number }[]): void;
  updateWidget(widgetId: string, patch: Partial<Widget>): void;
  /**
   * `updateWidget`, but targeted at a specific tab rather than whichever one
   * is active. A widget on a background tab can still have work in flight —
   * the Sitrep widget's AI summary, most likely — that resolves after the
   * user has switched away; without this the write would silently miss
   * (`updateWidget` reads `activeTab()`) and the result would be discarded.
   */
  updateWidgetIn(tabId: string, widgetId: string, patch: Partial<Widget>): void;
  /** Tidy the active tab: reading order, current sizes, no gaps. */
  arrangeWidgets(): void;

  /** Save one environment's settings. Defaults to the active one. */
  saveSettings(next: Settings, envId?: string): void;
  /** Appearance is one setting for the whole app, held on `global`. */
  appearance(): AppearanceSettings;
  saveAppearance(next: AppearanceSettings): Promise<void>;
  createEnvironment(name: string, color: string): Promise<void>;
  updateEnvironment(
    id: string,
    patch: { name?: string; color?: string; hidden?: boolean; collapsed?: boolean },
  ): Promise<void>;
  deleteEnvironment(id: string): Promise<void>;

  logEvent(event: EventInput): void;
}

// Derived views must be referentially stable: zustand calls these on every
// render to decide whether anything changed, so returning a fresh array each
// time is an infinite render loop. Both memos key on object identity, which the
// store already preserves — nothing mutates `layouts` in place.
const EMPTY_ENVIRONMENTS: Environment[] = [];

let tabsMemo: {
  global: Global | null;
  layouts: Record<string, Layout>;
  result: EnvTab[];
} | null = null;

function computeTabs(global: Global | null, layouts: Record<string, Layout>): EnvTab[] {
  if (!global) return [];
  return global.environments
    .filter((env) => !env.hidden)
    .flatMap((env) =>
      (layouts[env.id]?.tabs ?? []).map((tab) => ({ ...tab, environmentId: env.id })),
    );
}

/** Layout writes are debounced per environment: dragging a widget fires dozens
 *  of updates a second and each one would otherwise be a disk write. */
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

function persistLayout(envId: string, layout: Layout) {
  clearTimeout(pendingSaves.get(envId));
  pendingSaves.set(
    envId,
    setTimeout(() => {
      void ipc.layoutSave(envId, layout);
      pendingSaves.delete(envId);
    }, 400),
  );
}

/** Find which environment owns a tab. */
function envOf(layouts: Record<string, Layout>, tabId: string): string | null {
  for (const [envId, layout] of Object.entries(layouts)) {
    if (layout.tabs.some((t) => t.id === tabId)) return envId;
  }
  return null;
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  global: null,
  layouts: {},
  settings: {},
  activeTabId: null,
  lastTabByEnv: {},
  overviewEnvId: null,
  view: "board",

  async load() {
    const global = await ipc.globalLoad();
    const layouts: Record<string, Layout> = {};
    const settings: Record<string, Settings> = {};
    // Every environment is loaded and synced at once — that simultaneity is
    // what makes clicking the "Life" tab feel like nothing at all.
    await Promise.all(
      global.environments.map(async (env) => {
        const [layout, s] = await Promise.all([
          ipc.layoutLoad(env.id),
          ipc.settingsLoad(env.id).catch(() => DEFAULT_SETTINGS),
        ]);
        layouts[env.id] = layout;
        settings[env.id] = s;
      }),
    );

    const firstTab =
      layouts[global.activeEnvironmentId]?.tabs[0]?.id ??
      Object.values(layouts).flatMap((l) => l.tabs)[0]?.id ??
      null;

    set({ ready: true, global, layouts, settings, activeTabId: firstTab });
  },

  environments() {
    return get().global?.environments ?? EMPTY_ENVIRONMENTS;
  },

  tabs() {
    const { global, layouts } = get();
    if (tabsMemo && tabsMemo.global === global && tabsMemo.layouts === layouts) {
      return tabsMemo.result;
    }
    const result = computeTabs(global, layouts);
    tabsMemo = { global, layouts, result };
    return result;
  },

  activeTab() {
    const { activeTabId } = get();
    return get().tabs().find((t) => t.id === activeTabId) ?? null;
  },

  activeEnvironmentId() {
    const overview = get().overviewEnvId;
    if (overview) return overview;
    return get().activeTab()?.environmentId ?? get().global?.activeEnvironmentId ?? "default";
  },

  activeSettings() {
    return get().settings[get().activeEnvironmentId()] ?? DEFAULT_SETTINGS;
  },

  setView(view) {
    set({ view });
    get().logEvent({ kind: `view.${view}` });
  },

  selectTab(tabId) {
    const previous = get().activeTabId;
    const wasOverview = get().overviewEnvId !== null;
    // Already here *and* already showing it: nothing to do. The overview check
    // is load-bearing — it preserves `activeTabId`, so clicking the card for
    // the tab you came from is exactly the case where previous === tabId and
    // there is still work to do.
    if (previous === tabId && !wasOverview) return;
    // Selecting a real tab always leaves the overview — it behaves like any
    // other tab, not like a mode layered over one.
    // Started before anything mounts, so the measurement covers the whole
    // switch rather than just the fetching.
    switchStarted(envOf(get().layouts, tabId) ?? get().activeEnvironmentId(), tabId);
    set({ activeTabId: tabId, overviewEnvId: null, view: "board" });
    const envId = envOf(get().layouts, tabId);
    // Where you were in each world, so ⌘⇧N lands you back on it rather than on
    // whatever happens to be first. Session-only: it is a property of this
    // window's history, not of the board, so it never enters layout.json.
    if (envId) set((s) => ({ lastTabByEnv: { ...s.lastTabByEnv, [envId]: tabId } }));
    // Reached from the palette or a shortcut, this tab may live in a folded
    // environment. Unfold it: a board with no visible handle in the strip is
    // the same trap a collapsed tab group is not allowed to set.
    if (envId && get().environments().find((e) => e.id === envId)?.collapsed) {
      void get().updateEnvironment(envId, { collapsed: false });
    }
    if (envId && envId !== get().global?.activeEnvironmentId) {
      void ipc.environmentSetActive(envId);
      set((s) => (s.global ? { global: { ...s.global, activeEnvironmentId: envId } } : {}));
    }
    // Feeds the focus stats: tab switches per hour, project-switch count.
    // Leaving the overview back onto the tab you were already on is not a
    // switch, and counting it would inflate the number this board exists for.
    if (previous !== tabId) {
      get().logEvent({ kind: "tab.switch", meta: { from: previous, to: tabId } });
    }
    // Stamp the tab being left with when that happened, so the sitrep widget
    // can tell how long it has sat unopened. `previous` is null on the very
    // first selection — there is no outgoing tab to stamp.
    if (previous !== tabId && previous !== null) {
      const prevEnvId = envOf(get().layouts, previous);
      if (prevEnvId) {
        set((s) => {
          const layout = s.layouts[prevEnvId];
          if (!layout) return {};
          const next = {
            ...layout,
            tabs: layout.tabs.map((t) =>
              t.id === previous ? { ...t, lastVisitedAt: new Date().toISOString() } : t,
            ),
          };
          persistLayout(prevEnvId, next);
          return { layouts: { ...s.layouts, [prevEnvId]: next } };
        });
      }
    }
  },

  /**
   * ⌘1…⌘9, scoped to the environment you are in.
   *
   * Numbering used to run across every visible tab, which made a tab's number
   * a property of the whole window: fold one environment and every number
   * below it moved. Scoped, ⌘3 is the third tab of the world you are working
   * in and stays the third tab whatever else is on screen.
   */
  selectTabByIndex(index) {
    const envId = get().activeEnvironmentId();
    const tab = get().tabs().filter((t) => t.environmentId === envId)[index];
    if (tab) get().selectTab(tab.id);
  },

  /**
   * Go to an environment: unfold it and select the tab you last had there.
   *
   * `activeTabId` is left alone by `showOverview` and friends precisely so this
   * can exist — the tab you were on in a world is where you land when you come
   * back to it.
   */
  activateEnvironment(envId) {
    const envTabs = get().tabs().filter((t) => t.environmentId === envId);
    if (envTabs.length === 0) return;
    void get().updateEnvironment(envId, { collapsed: false });
    const remembered = get().lastTabByEnv[envId];
    const tab = envTabs.find((t) => t.id === remembered) ?? envTabs[0]!;
    get().selectTab(tab.id);
  },

  cycleTab(delta) {
    const tabs = get().tabs();
    if (tabs.length === 0) return;
    const current = tabs.findIndex((t) => t.id === get().activeTabId);
    const next = (((current + delta) % tabs.length) + tabs.length) % tabs.length;
    get().selectTab(tabs[next]!.id);
  },

  addTab(environmentId) {
    const envId = environmentId ?? get().activeEnvironmentId();
    const env = get().environments().find((e) => e.id === envId);
    const tab = {
      id: uid("tab"),
      name: "New tab",
      color: env?.color ?? null,
      groupId: null,
      widgets: [],
    };
    set((s) => {
      const layout = s.layouts[envId] ?? { version: 1, groups: [], tabs: [] };
      const next = { ...layout, tabs: [...layout.tabs, tab] };
      persistLayout(envId, next);
      // Clearing the overview matters: `activeTabId` now points at the new
      // tab, and leaving the overview up would make those two disagree about
      // what you are looking at.
      return {
        layouts: { ...s.layouts, [envId]: next },
        activeTabId: tab.id,
        overviewEnvId: null,
        view: "board",
      };
    });
    get().logEvent({ kind: "tab.create" });
  },

  async promoteToTab(input) {
    const envId = input.environmentId ?? get().activeEnvironmentId();
    // Register first: a failure here must not leave a half-built tab behind.
    const project = await ipc.projectRegister(envId, input.path);
    const tab = buildPromotedTab(
      { projectId: project.id, name: input.name, path: input.path, remote: input.remote },
      uid,
    );
    set((s) => {
      const layout = s.layouts[envId] ?? { version: 1, groups: [], tabs: [] };
      const next = { ...layout, tabs: [...layout.tabs, tab] };
      persistLayout(envId, next);
      return {
        layouts: { ...s.layouts, [envId]: next },
        activeTabId: tab.id,
        overviewEnvId: null,
        view: "board",
      };
    });
    get().logEvent({ kind: "tab.promote", project: project.id });
  },

  renameTab(tabId, name) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },


  showOverview(envId) {
    set({ overviewEnvId: envId, view: "board" });
  },

  setEnvironmentCollapsed(envId, collapsed) {
    void get().updateEnvironment(envId, { collapsed });
  },

  moveTabTo(tabId, toIndex, groupId) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = { ...layout, ...moveTab(layout, tabId, toIndex, groupId) };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  /** Move a whole group — pill and run together — to an insertion boundary. */
  moveGroupTo(envId, groupId, toIndex) {
    set((s) => {
      const layout = s.layouts[envId];
      if (!layout) return {};
      const next = { ...layout, ...moveGroup(layout, groupId, toIndex) };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  exportTabs(envId, tabIds) {
    const layout = get().layouts[envId];
    if (!layout) return "";
    const env = get().environments().find((e) => e.id === envId);
    return JSON.stringify(
      exportLayout(layout, { tabIds, from: env?.name, exportedAt: new Date().toISOString() }),
      null,
      2,
    );
  },

  importTabs(envId, document) {
    // Every id is re-minted inside `importLayout`. That is the whole reason
    // this goes through a module instead of a spread: ids are unique across
    // environments, not within one, and `envOf` returns the first match.
    const { tabs, groups } = importLayout(document, uid);
    set((s) => {
      const layout = s.layouts[envId] ?? { version: 1, groups: [], tabs: [] };
      const next = {
        ...layout,
        groups: [...layout.groups, ...groups],
        tabs: [...layout.tabs, ...tabs],
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
    if (tabs[0]) get().selectTab(tabs[0].id);
    get().logEvent({ kind: "layout.import", meta: { tabs: tabs.length } });
    return tabs.length;
  },

  setTabGroup(tabId, groupId) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = { ...layout, ...setTabGroupIn(layout, tabId, groupId) };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  createGroup(tabId, name) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    set((s) => {
      const layout = s.layouts[envId]!;
      const tab = layout.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const group = {
        id: uid("grp"),
        name,
        // The tab's own colour, or its environment's — a new group should look
        // like the thing it was made from, not like a seventh colour.
        color: tab.color ?? s.global?.environments.find((e) => e.id === envId)?.color ?? "#2f6ae8",
        collapsed: false,
      };
      // Add the group before the membership move, or setTabGroup's normalize
      // would drop a group no tab points at yet.
      const withGroup = { ...layout, groups: [...layout.groups, group] };
      const next = { ...withGroup, ...setTabGroupIn(withGroup, tabId, group.id) };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  renameGroup(envId, groupId, name) {
    set((s) => {
      const layout = s.layouts[envId];
      if (!layout) return {};
      const next = {
        ...layout,
        groups: layout.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  setGroupCollapsed(envId, groupId, collapsed) {
    const layout = get().layouts[envId];
    if (!layout) return;
    if (collapsed) {
      // Collapsing must never hide the board you are looking at. Move to the
      // nearest tab outside the group first; if this environment has none,
      // refuse rather than leave the user on a tab with no visible handle.
      const active = get().activeTabId;
      const inGroup = layout.tabs.filter((t) => t.groupId === groupId);
      if (inGroup.some((t) => t.id === active)) {
        const escape = layout.tabs.find((t) => t.groupId !== groupId);
        if (!escape) return;
        get().selectTab(escape.id);
      }
    }
    set((s) => {
      const current = s.layouts[envId]!;
      const next = {
        ...current,
        groups: current.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  ungroup(envId, groupId) {
    set((s) => {
      const layout = s.layouts[envId];
      if (!layout) return {};
      const next = {
        ...layout,
        groups: layout.groups.filter((g) => g.id !== groupId),
        tabs: layout.tabs.map((t) => (t.groupId === groupId ? { ...t, groupId: null } : t)),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  setTabColor(tabId, color) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, color } : t)),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  closeTab(tabId) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    const tabsBefore = get().tabs();
    const index = tabsBefore.findIndex((t) => t.id === tabId);
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = { ...layout, tabs: layout.tabs.filter((t) => t.id !== tabId) };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
    if (get().activeTabId === tabId) {
      const remaining = get().tabs();
      const fallback = remaining[Math.min(index, remaining.length - 1)];
      set({ activeTabId: fallback?.id ?? null, overviewEnvId: null });
    }
    get().logEvent({ kind: "tab.close" });
  },

  addWidget(kind, options = {}) {
    const tab = get().activeTab();
    if (!tab) return;
    const envId = tab.environmentId;
    // Drop it at the bottom of the current stack so nothing already placed moves.
    const y = tab.widgets.reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0);
    const widget: Widget = {
      id: uid("w"),
      kind,
      title: options.title ?? null,
      connectionId: null,
      filter: (options.filter ?? {}) as Record<string, unknown>,
      config: {
        ...(options.config ?? {}),
        // The preset's own filter, recorded verbatim at creation. It is what
        // lets `resolveFilter` tell a control the user touched from a default
        // they never looked at — see src/lib/instructions.ts.
        ...(options.filter ? { presetFilter: { ...options.filter } } : {}),
      },
      refreshSeconds: null,
      layout: { x: 0, y, w: 4, h: 6 },
    };
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) =>
          t.id === tab.id ? { ...t, widgets: [...t.widgets, widget] } : t,
        ),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
    get().logEvent({ kind: "widget.add", meta: { kind } });
  },

  removeWidget(widgetId) {
    const tab = get().activeTab();
    if (!tab) return;
    const envId = tab.environmentId;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) =>
          t.id === tab.id ? { ...t, widgets: t.widgets.filter((w) => w.id !== widgetId) } : t,
        ),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
    // A widget's instructions are its own file; deleting the widget deletes it.
    // Fire and forget: most widgets never had one, and a failure here must not
    // leave a deleted widget on screen.
    void ipc.widgetInstructionsClear(envId, widgetId).catch(() => {});
    get().logEvent({ kind: "widget.remove" });
  },

  updateWidgetLayout(updates) {
    const tab = get().activeTab();
    if (!tab) return;
    const envId = tab.environmentId;
    const byId = new Map(updates.map((u) => [u.id, u]));
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                widgets: t.widgets.map((w) => {
                  const u = byId.get(w.id);
                  return u ? { ...w, layout: { x: u.x, y: u.y, w: u.w, h: u.h } } : w;
                }),
              }
            : t,
        ),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  updateWidget(widgetId, patch) {
    const tab = get().activeTab();
    if (!tab) return;
    const envId = tab.environmentId;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, widgets: t.widgets.map((w) => (w.id === widgetId ? { ...w, ...patch } : w)) }
            : t,
        ),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  updateWidgetIn(tabId, widgetId, patch) {
    const envId = envOf(get().layouts, tabId);
    if (!envId) return;
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) =>
          t.id === tabId
            ? { ...t, widgets: t.widgets.map((w) => (w.id === widgetId ? { ...w, ...patch } : w)) }
            : t,
        ),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  arrangeWidgets() {
    const tab = get().activeTab();
    if (!tab || tab.widgets.length === 0) return;
    const envId = tab.environmentId;
    // GRID_COLS is the canvas's own column count; packing against anything
    // else would place widgets the grid then immediately moves.
    const packed = packWidgets(tab.widgets, GRID_COLS);
    set((s) => {
      const layout = s.layouts[envId]!;
      const next = {
        ...layout,
        tabs: layout.tabs.map((t) => (t.id === tab.id ? { ...t, widgets: packed } : t)),
      };
      persistLayout(envId, next);
      return { layouts: { ...s.layouts, [envId]: next } };
    });
  },

  appearance() {
    return get().global?.appearance ?? DEFAULT_APPEARANCE;
  },

  async saveAppearance(next) {
    // Optimistic: a second control changed before this save returns must see
    // the first change, or the later save overwrites it with the stale value.
    const current = get().global;
    if (current) set({ global: { ...current, appearance: next } });
    const global = await ipc.globalAppearanceSave(next);
    set({ global });
  },

  saveSettings(next, envId) {
    // Explicit when the settings page is pinned to an environment other than
    // the active one — writing to the wrong environment's settings.json is
    // exactly the leak the isolation wall exists to prevent.
    const target = envId ?? get().activeEnvironmentId();
    set((s) => ({ settings: { ...s.settings, [target]: next } }));
    void ipc.settingsSave(target, next);
  },

  async createEnvironment(name, color) {
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || uid("env");
    const global = await ipc.environmentCreate(id, name, color);
    const [layout, settings] = await Promise.all([
      ipc.layoutLoad(id),
      ipc.settingsLoad(id).catch(() => DEFAULT_SETTINGS),
    ]);
    // Land in the new environment rather than leaving the user where they were:
    // you make it, you go there. It has no tabs yet, so show its overview and
    // make it the active environment (so the next `New tab` lands in it, not
    // the old one). `activeTabId: null` lets `activeEnvironmentId()` fall
    // through to `global.activeEnvironmentId`.
    void ipc.environmentSetActive(id);
    set((s) => ({
      global: { ...global, activeEnvironmentId: id },
      layouts: { ...s.layouts, [id]: layout },
      settings: { ...s.settings, [id]: settings },
      activeTabId: null,
      overviewEnvId: id,
      view: "board",
    }));
  },

  async updateEnvironment(id, patch) {
    const global = await ipc.environmentUpdate(id, patch);
    set({ global });
  },

  async deleteEnvironment(id) {
    const global = await ipc.environmentDelete(id);
    set((s) => {
      const layouts = { ...s.layouts };
      const settings = { ...s.settings };
      delete layouts[id];
      delete settings[id];
      return { global, layouts, settings };
    });
    if (!get().activeTab()) set({ activeTabId: get().tabs()[0]?.id ?? null });
  },

  logEvent(event) {
    ipc.eventLog(get().activeEnvironmentId(), event);
  },
}));
