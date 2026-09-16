// The action registry. Everything the app can do is one entry here, which is
// what makes the palette exhaustive rather than curated.
//
// Definition of done for every future feature (§5.10): it registers its actions
// here and gets a sensible key. A feature that is only reachable by mouse is not
// finished.

import { ipc } from "../lib/ipc";
import { useStore } from "../state/store";
import { useFocus } from "../state/focus";
import { controlsOf, focusedControl, focusedWidgetElement, nextControl } from "./controls";
import { useUi } from "../state/ui";

export interface Action {
  id: string;
  title: string;
  group: string;
  /** Secondary line in the palette. */
  hint?: string;
  /** Extra fuzzy-match fodder that isn't worth showing. */
  keywords?: string;
  /**
   * `global` fires even while typing (the palette must always open);
   * `board` is suppressed in text fields so `j` stays a letter.
   */
  scope?: "global" | "board";
  run: () => void;
}

/**
 * Shipped preset. Users override it in `keymap.json`; conflicts are surfaced
 * rather than silently resolved.
 */
export const DEFAULT_KEYMAP: Record<string, string[]> = {
  "app.palette": ["mod+k"],
  "app.settings": ["mod+,"],
  "app.board": ["mod+shift+b"],
  "app.hints": ["shift+?"],
  "app.escape": ["escape"],

  "tab.new": ["mod+t"],
  "tab.close": ["mod+w"],
  // ⌘E dispatches: a focused note takes it, otherwise the tab rename does.
  // bindingIndex is first-writer-wins, so two actions cannot share one key.
  "edit.focused": ["mod+e"],
  "tab.rename": [],
  "notes.save": ["mod+s"],
  "tab.next": ["ctrl+tab", "mod+alt+arrowright"],
  "tab.prev": ["ctrl+shift+tab", "mod+alt+arrowleft"],
  "tab.go.1": ["mod+1"],
  "tab.go.2": ["mod+2"],
  "tab.go.3": ["mod+3"],
  "tab.go.4": ["mod+4"],
  "tab.go.5": ["mod+5"],
  "tab.go.6": ["mod+6"],
  "tab.go.7": ["mod+7"],
  "tab.go.8": ["mod+8"],
  "tab.go.9": ["mod+9"],

  // ⌘⇧1…9 addresses environments the way ⌘1…9 addresses tabs: by position,
  // counted down the rail. (⌘⇧N — the letter — is New environment, above.)
  "env.go.1": ["mod+shift+1"],
  "env.go.2": ["mod+shift+2"],
  "env.go.3": ["mod+shift+3"],
  "env.go.4": ["mod+shift+4"],
  "env.go.5": ["mod+shift+5"],
  "env.go.6": ["mod+shift+6"],
  "env.go.7": ["mod+shift+7"],
  "env.go.8": ["mod+shift+8"],
  "env.go.9": ["mod+shift+9"],

  "widget.add": ["mod+shift+a"],
  "widget.remove": ["mod+shift+x"],
  "widget.arrange": ["mod+shift+r"],

  "focus.next": ["tab"],
  "focus.prev": ["shift+tab"],
  // `l` and `h` used to move between widgets. They move between a row's
  // buttons now: rows run down the widget and their actions run across it, so
  // j/k and h/l are the two axes rather than two different levels.
  "control.next": ["l"],
  "control.prev": ["h"],
  "item.next": ["j", "arrowdown"],
  "item.prev": ["k", "arrowup"],
  "item.open": ["enter", "o"],
  "item.launch": ["mod+enter"],
  "item.comment": ["c"],
  "item.approve": ["shift+a"],
  "item.archive": ["a"],
  "sync.now": ["mod+r"],

  "env.new": ["mod+shift+n"],
};

/**
 * Move DOM focus between the focused widget's controls.
 *
 * Nothing is stored: the list is read from the DOM each time, so a widget that
 * refreshed between two presses is navigated as it is now rather than as it was.
 */
function moveControl(delta: number): void {
  const widget = focusedWidgetElement();
  if (!widget) return;
  nextControl(controlsOf(widget), document.activeElement, delta)?.focus();
}

/** The order Tab traverses: reading order across the grid. */
function widgetOrder(): string[] {
  const tab = useStore.getState().activeTab();
  if (!tab) return [];
  return [...tab.widgets]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .map((w) => w.id);
}

export function buildActions(): Action[] {
  const store = useStore.getState();
  const ui = useUi.getState();
  const focus = useFocus.getState();

  const actions: Action[] = [
    {
      id: "app.palette",
      title: "Open command palette",
      group: "App",
      scope: "global",
      keywords: "search find run",
      run: () => useUi.getState().togglePalette(true),
    },
    {
      id: "app.settings",
      title: "Open app settings",
      group: "App",
      keywords: "preferences appearance theme keyboard environments",
      run: () => {
        // Global panels, no environment pinned — the tab gears cover the
        // per-environment side.
        useUi.getState().openSettingsPanel("appearance");
        store.setView("settings");
      },
    },
    {
      id: "app.board",
      title: "Back to board",
      group: "App",
      run: () => store.setView("board"),
    },
    // One entry per theme rather than a toggle: the palette is searched, so
    // typing "dark" should land on dark whatever the current setting is, and
    // choosing again should be a no-op rather than a flip.
    ...(["light", "dark", "system"] as const).map((theme) => ({
      id: `app.theme.${theme}`,
      title: theme === "system" ? "Theme: match system" : `Theme: ${theme}`,
      group: "App",
      hint: store.appearance().theme === theme ? "current" : undefined,
      keywords: "appearance dark light mode colour color",
      run: () => void store.saveAppearance({ ...store.appearance(), theme }),
    })),
    {
      id: "app.hints",
      title: "Show shortcut hints",
      group: "App",
      hint: "Hold ⌘ for the same overlay",
      run: () => useUi.getState().flashHints(),
    },
    {
      id: "app.guide",
      title: "Features guide",
      group: "App",
      keywords: "help widgets integrations concepts onboarding what does this do",
      run: () => useUi.getState().toggleGuide(true),
    },
    {
      id: "app.escape",
      title: "Close overlay / drop focus",
      group: "App",
      scope: "global",
      run: () => {
        const u = useUi.getState();
        if (u.paletteOpen) u.togglePalette(false);
        else if (u.pickerOpen) u.togglePicker(false);
        else if (u.guideOpen) u.toggleGuide(false);
        // Escape unwinds one level at a time. A control first — leaving the
        // widget from inside a button would skip a step you can see.
        else if (focusedControl()) focusedControl()?.blur();
        else useFocus.getState().focusWidget(null);
      },
    },

    {
      id: "tab.new",
      title: "New tab",
      group: "Tabs",
      run: () => store.addTab(),
    },
    {
      id: "tab.close",
      title: "Close tab",
      group: "Tabs",
      run: () => {
        const id = useStore.getState().activeTabId;
        if (id) useStore.getState().closeTab(id);
      },
    },
    {
      id: "tab.rename",
      title: "Rename tab",
      group: "Tabs",
      run: () => useUi.getState().startRenamingTab(useStore.getState().activeTabId),
    },
    {
      id: "edit.focused",
      title: "Edit focused note, or rename tab",
      group: "Board",
      hint: "Notes take ⌘E only while focused",
      run: () => {
        const focused = useFocus.getState().focusedWidgetId;
        const widget = store.activeTab()?.widgets.find((w) => w.id === focused);
        if (widget?.kind === "notes") useUi.getState().editNote(widget.id);
        else useUi.getState().startRenamingTab(store.activeTabId);
      },
    },
    {
      id: "notes.save",
      title: "Save note and render",
      group: "Board",
      // Global, or isTypingTarget would swallow it inside the very textarea
      // it exists to leave.
      scope: "global",
      run: () => useUi.getState().editNote(null),
    },
    {
      id: "tab.next",
      title: "Next tab",
      group: "Tabs",
      run: () => store.cycleTab(1),
    },
    {
      id: "tab.prev",
      title: "Previous tab",
      group: "Tabs",
      run: () => store.cycleTab(-1),
    },

    {
      id: "widget.add",
      title: "Add widget…",
      group: "Board",
      keywords: "new source filter view",
      run: () => useUi.getState().togglePicker(true),
    },
    {
      id: "widget.remove",
      title: "Remove focused widget",
      group: "Board",
      run: () => {
        const id = useFocus.getState().focusedWidgetId;
        if (id) useStore.getState().removeWidget(id);
      },
    },
    {
      // "focus", deliberately not "stop port 3000": a fuzzy-matched,
      // Enter-to-run list where 3000 and 3001 are one character apart is
      // exactly the accident to design out — and it would be a voice-reachable
      // process kill the day Phase 5 lands.
      id: "devservers.focus",
      title: "Dev servers: focus",
      group: "Board",
      keywords: "port listening EADDRINUSE localhost docker",
      run: () => {
        const widget = store.activeTab()?.widgets.find((w) => w.kind === "devservers");
        if (widget) useFocus.getState().focusWidget(widget.id);
        else useUi.getState().showToast("No dev servers widget on this tab — add one with ⌘⇧A");
      },
    },
    {
      id: "eol.focus",
      title: "Support watch: focus",
      group: "Board",
      keywords: "eol end of life runtime php node symfony deprecated",
      run: () => {
        const widget = store.activeTab()?.widgets.find((w) => w.kind === "eol");
        if (widget) useFocus.getState().focusWidget(widget.id);
        else useUi.getState().showToast("No support watch widget on this tab — add one with ⌘⇧A");
      },
    },
    {
      id: "layout.export",
      title: "Export this tab as a layout file…",
      group: "Board",
      keywords: "share copy backup json portable",
      run: () => {
        const s = useStore.getState();
        const tab = s.activeTab();
        if (!tab) return;
        const name = tab.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        void ipc
          .saveTextFile(`${name || "tab"}.json`, s.exportTabs(tab.environmentId, [tab.id]))
          .then((path) => path && useUi.getState().showToast(`Written to ${path}`))
          .catch((e) => useUi.getState().showToast(String(e)));
      },
    },
    {
      id: "layout.import",
      title: "Import a layout file…",
      group: "Board",
      keywords: "restore copy json portable",
      run: () => {
        const s = useStore.getState();
        const envId = s.activeEnvironmentId();
        void ipc
          .openTextFile()
          .then((text) => {
            if (!text) return;
            const count = s.importTabs(envId, text);
            useUi.getState().showToast(`${count} tab${count === 1 ? "" : "s"} added`);
          })
          .catch((e) =>
            useUi.getState().showToast(e instanceof Error ? e.message : String(e)),
          );
      },
    },
    {
      id: "widget.arrange",
      title: "Rearrange all widgets",
      group: "Board",
      run: () => useStore.getState().arrangeWidgets(),
    },

    {
      id: "focus.next",
      title: "Focus next widget",
      group: "Navigate",
      run: () => useFocus.getState().moveWidgetFocus(widgetOrder(), 1),
    },
    {
      id: "focus.prev",
      title: "Focus previous widget",
      group: "Navigate",
      run: () => useFocus.getState().moveWidgetFocus(widgetOrder(), -1),
    },
    {
      id: "item.next",
      title: "Next item",
      group: "Navigate",
      run: () => useFocus.getState().moveItem(1),
    },
    {
      id: "item.prev",
      title: "Previous item",
      group: "Navigate",
      run: () => useFocus.getState().moveItem(-1),
    },
    {
      id: "item.open",
      title: "Press the selected button, or open the focused item",
      group: "Navigate",
      run: () => {
        // A focused control owns Enter. Clicking it rather than dispatching a
        // key event keeps every widget's existing `onClick` the one path an
        // action takes, whether it was reached by mouse or by keyboard.
        const control = focusedControl();
        if (control) control.click();
        else useFocus.getState().openFocusedItem();
      },
    },
    {
      id: "control.next",
      title: "Next button in the widget",
      group: "Navigate",
      hint: "Across the row: its actions, then the widget's own",
      run: () => moveControl(1),
    },
    {
      id: "control.prev",
      title: "Previous button in the widget",
      group: "Navigate",
      run: () => moveControl(-1),
    },
    {
      id: "item.launch",
      title: "Launch focused project",
      group: "Navigate",
      hint: "Terminal in the project directory, Claude Code running",
      keywords: "terminal claude session start",
      run: () => useFocus.getState().runVerb("launch"),
    },

    {
      id: "item.comment",
      title: "Comment on focused item",
      group: "Navigate",
      hint: "Opens a composer — nothing sends until you press Send",
      run: () => useFocus.getState().runVerb("comment"),
    },
    {
      id: "item.approve",
      title: "Approve focused pull request",
      group: "Navigate",
      run: () => useFocus.getState().runVerb("approve"),
    },
    {
      id: "item.archive",
      title: "Mark focused item read",
      group: "Navigate",
      run: () => useFocus.getState().runVerb("archive"),
    },
    {
      id: "sync.now",
      title: "Sync all connections now",
      group: "App",
      hint: "The scheduler already does this on a cadence",
      keywords: "refresh fetch reload pull",
      run: () => {
        const store = useStore.getState();
        void ipc.syncNow(store.activeEnvironmentId()).then((count) => {
          useUi.getState().showToast(`Synced ${count} item${count === 1 ? "" : "s"}`);
        });
      },
    },

    {
      id: "env.new",
      title: "New environment…",
      group: "Environments",
      keywords: "work personal client profile isolate",
      run: () => {
        useStore.getState().setView("settings");
        useUi.getState().openSettingsPanel("environments");
      },
    },
  ];

  // Per-environment actions, generated so the palette names your worlds rather
  // than making you remember which one is hidden.
  store.environments().forEach((env) => {
    actions.push({
      id: `env.toggle.${env.id}`,
      title: `${env.hidden ? "Show" : "Hide"} ${env.name}`,
      group: "Environments",
      hint: env.hidden ? "Currently hidden from the tab strip" : "Focus mode: hide its tabs",
      run: () => void useStore.getState().updateEnvironment(env.id, { hidden: !env.hidden }),
    });
    actions.push({
      id: `env.newtab.${env.id}`,
      title: `New tab in ${env.name}`,
      group: "Environments",
      run: () => useStore.getState().addTab(env.id),
    });
  });

  // Positional environment jumps, counted down the rail.
  //
  // One key, two readings, and the second is what makes it a switch rather than
  // a toggle: on an environment you are not in, it takes you there — unfolding
  // it and landing on the tab you last had. On the one you are already in, it
  // folds the tabs away and leaves the board exactly where it was, because
  // tidying the rail is not navigation.
  const visibleEnvs = store.environments().filter((e) => !e.hidden);
  for (let i = 0; i < 9; i++) {
    const env = visibleEnvs[i];
    const isActive = env?.id === store.activeEnvironmentId();
    actions.push({
      id: `env.go.${i + 1}`,
      title: env
        ? isActive
          ? `${env.collapsed ? "Unfold" : "Fold"} ${env.name}`
          : `Go to ${env.name}`
        : `Go to environment ${i + 1}`,
      group: "Environments",
      hint: env && isActive ? "You are here — folds its tabs away" : undefined,
      run: () => {
        if (!env) return;
        const s = useStore.getState();
        if (env.id === s.activeEnvironmentId()) void s.updateEnvironment(env.id, { collapsed: !env.collapsed });
        else s.activateEnvironment(env.id);
      },
    });
  }

  // Positional tab jumps, within the environment you are in. These are
  // generated rather than hand-written so the palette lists the tab you
  // actually have at slot 3, not "Tab 3".
  const activeEnvId = store.activeEnvironmentId();
  const tabs = store.tabs();
  const envTabs = tabs.filter((t) => t.environmentId === activeEnvId);
  for (let i = 0; i < 9; i++) {
    const tab = envTabs[i];
    actions.push({
      id: `tab.go.${i + 1}`,
      title: tab ? `Go to ${tab.name}` : `Go to tab ${i + 1}`,
      group: "Tabs",
      hint: tab ? store.environments().find((e) => e.id === tab.environmentId)?.name : undefined,
      run: () => useStore.getState().selectTabByIndex(i),
    });
  }

  // Everything ⌘1…9 cannot reach — another environment's tabs, and this one's
  // tenth onward — is still reachable by name in the palette.
  tabs.filter((t) => !envTabs.slice(0, 9).includes(t)).forEach((tab) => {
    actions.push({
      id: `tab.open.${tab.id}`,
      title: `Go to ${tab.name}`,
      group: "Tabs",
      run: () => useStore.getState().selectTab(tab.id),
    });
  });

  void ui;
  void focus;
  return actions;
}

/** Bindings pointing at more than one action, for the keymap editor. */
export function findConflicts(keymap: Record<string, string[]>): Record<string, string[]> {
  const byBinding: Record<string, string[]> = {};
  for (const [actionId, bindings] of Object.entries(keymap)) {
    for (const binding of bindings) {
      (byBinding[binding] ??= []).push(actionId);
    }
  }
  return Object.fromEntries(Object.entries(byBinding).filter(([, ids]) => ids.length > 1));
}
