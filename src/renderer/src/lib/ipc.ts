// Typed wrappers over the Rust commands, plus a localStorage-backed stand-in so
// `npm run dev` (plain Vite, no Tauri window) is still a working app. Widget and
// layout work is 90% of the frontend, and waiting on a Rust rebuild to nudge a
// grid column would be a miserable way to build it.

import type {
  AiActionInfo,
  AppearanceSettings,
  AiDraft,
  AiContext,
  Compiled,
  EolBoard,
  DevProbe,
  DevServerFilter,
  DevServerListing,
  Item,
  ItemFilter,
  EventInput,
  EventRow,
  FoundApp,
  Instructions,
  Global,
  Layout,
  McpReport,
  LocalEvent,
  Occurrence,
  PathsInfo,
  Product,
  ProductState,
  Project,
  RepoListing,
  Settings,
  Watchlist,
} from "../types";

// The preload puts `window.ddd` there inside the Electron window and nowhere
// else, which is what makes the browser preview a different code path.
const bridge = typeof window !== "undefined" ? window.ddd : undefined;
const isNative = bridge !== undefined;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!bridge) throw new Error(`${cmd} needs the desktop app`);
  return bridge.invoke<T>(cmd, args);
}

/**
 * One call per question, however many widgets are asking.
 *
 * A board with two projects widgets issued two identical `projects_list`
 * calls; in development React's StrictMode mounts every effect twice, so it
 * issued four. Measured on a real board, those four cost 481ms where one cost
 * 124ms — the work was not just duplicated but serialized behind itself.
 *
 * This is coalescing, not caching: the entry is dropped the moment the call
 * settles, so the next question is asked again. Only reads may pass through
 * here. Sharing a write would mean two callers believing they each performed
 * an action that happened once.
 */
const inFlight = new Map<string, Promise<unknown>>();

function shared<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const key = `${cmd}:${JSON.stringify(args ?? {})}`;
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = call<T>(cmd, args).finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

// --- browser stand-in -------------------------------------------------------

const mem = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`ddd:${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  write<T>(key: string, value: T): void {
    localStorage.setItem(`ddd:${key}`, JSON.stringify(value));
  },
};

const MOCK_PRODUCTS: Product[] = [
  {
    key: "marktplaatser/post-ads",
    projectId: "marktplaatser",
    productId: "post-ads",
    name: "Post ads",
    run: "python -m marktplaatser --post",
    dir: "/Users/you/Projects/marktplaatser",
    port: null,
    dirExists: true,
    needsApproval: null,
    state: { state: "running", pid: 40122, since: new Date(Date.now() - 264_000).toISOString() },
    log: "posting ad 3/14…\nposting ad 4/14…",
  },
  {
    key: "climate4u/serve",
    projectId: "climate4u",
    productId: "serve",
    name: "Dev server",
    run: "npm run dev",
    dir: "/Users/you/Projects/climate4u",
    port: 3000,
    dirExists: true,
    needsApproval: null,
    state: { state: "exited", since: new Date(Date.now() - 7_200_000).toISOString() },
    log: "",
  },
  {
    key: "invoices/monthly",
    projectId: "invoices",
    productId: "monthly",
    name: "Monthly run",
    run: "./bin/invoice --month",
    dir: "/Users/you/Projects/invoices",
    port: null,
    dirExists: true,
    needsApproval: "not approved to run in this environment yet",
    state: { state: "stopped" },
    log: "",
  },
];

const MOCK_GLOBAL: Global = {
  version: 1,
  appearance: {
    theme: "system",
    look: "classic",
    terminalApp: null,
    editor: null,
    launchCommand: "claude",
    defaultRefreshSeconds: 300,
    showShortcutHints: true,
  },
  environments: [
    { id: "default", name: "Default", color: "#2f6ae8", hidden: false },
  ],
  activeEnvironmentId: "default",
};

/** Repos with real-length paths, so row truncation can be built without Tauri. */
const MOCK_REPOS: RepoListing = {
  rows: [
    {
      nameWithOwner: "agitri/climate4u",
      url: "https://github.com/agitri/climate4u",
      remote: "github.com/agitri/climate4u",
      cloneUrl: "git@github.com:agitri/climate4u.git",
      facts: "private · php",
      pushedAt: new Date(Date.now() - 3_600_000).toISOString(),
      localPath: "/Users/renegerrits/Projects/climate4u",
      matchConfidence: "exact",
      missing: false,
      projectId: "climate4u",
    },
    {
      nameWithOwner: "agitri/ddd",
      url: "https://github.com/agitri/ddd",
      remote: "github.com/agitri/ddd",
      cloneUrl: "git@github.com:agitri/ddd.git",
      facts: "private · rust",
      pushedAt: new Date(Date.now() - 172_800_000).toISOString(),
      localPath: "/Users/renegerrits/Projects/DDD",
      matchConfidence: "exact",
      missing: false,
      projectId: null,
    },
    {
      nameWithOwner: "agitri/dedesignwinkel",
      url: "https://github.com/agitri/dedesignwinkel",
      remote: "github.com/agitri/dedesignwinkel",
      cloneUrl: "git@github.com:agitri/dedesignwinkel.git",
      facts: "private · typescript",
      pushedAt: new Date(Date.now() - 172_800_000).toISOString(),
      localPath: "/Users/renegerrits/Projects/dedesignwinkel",
      matchConfidence: "fallback",
      missing: false,
      projectId: null,
    },
  ],
  localOnly: [],
  capped: false,
  total: 3,
};

/** A plausible ICM plan, so the provenance panel can be built without Tauri. */
const MOCK_CONTEXT: AiContext = {
  project: "ddd",
  plan: {
    files: [
      { name: "a-conventions.md", path: "/Users/you/Projects/ddd/.ddd/icm/a-conventions.md", bytes: 2140, used: 2140, truncated: false },
      { name: "b-architecture.md", path: "/Users/you/Projects/ddd/.ddd/icm/b-architecture.md", bytes: 9800, used: 8000, truncated: true },
      { name: "c-current-focus.md", path: "/Users/you/Projects/ddd/.ddd/icm/c-current-focus.md", bytes: 640, used: 640, truncated: false },
    ],
    skipped: ["z-old-notes.md"],
    totalUsed: 10900,
    budget: 24000,
    dir: "/Users/you/Projects/ddd/.ddd/icm",
    missing: false,
  },
};

function mockLayout(): Layout {
  return {
    version: 1,
    groups: [],
    tabs: [
      {
        id: "tab-board",
        name: "Board",
        color: "#2f6ae8",
        groupId: null,
        widgets: [
          w("w-clock", "clock", 0, 0, 3, 4),
          w("w-notes", "notes", 3, 0, 5, 8),
        ],
      },
      {
        id: "tab-projects",
        name: "Projects",
        color: "#00a99f",
        groupId: null,
        widgets: [w("w-projects", "projects", 0, 0, 8, 10)],
      },
    ],
  };
}

function w(id: string, kind: string, x: number, y: number, wd: number, h: number) {
  return {
    id,
    kind,
    title: null,
    connectionId: null,
    filter: {},
    config: {},
    refreshSeconds: null,
    layout: { x, y, w: wd, h },
  };
}

/** Sample rows so the browser preview can exercise item widgets. */
function mockItems(filter: ItemFilter): Item[] {
  const now = Date.now();
  const rows: [string, string, string, string][] = [
    ["pr-142", "pull_request", "agitri/ddd", "agitri/ddd#142 Normalize the Item model across adapters"],
    ["pr-138", "review_request", "agitri/ddd", "agitri/ddd#138 Grid canvas: only drag from the header"],
    ["cmt-91", "comment", "agitri/ddd", "agitri/ddd: can we keep refs stable across syncs?"],
    ["iss-77", "issue", "agitri/ddd", "agitri/ddd#77 Gmail adapter: device-code flow"],
  ];
  return rows
    .map(([key, kind, project, title], i) => ({
      id: `preview:${key}`,
      environmentId: "default",
      connectionId: "preview",
      source: "github",
      kind,
      project,
      title,
      body: i === 0 ? "ci success · approved" : null,
      url: "https://example.invalid",
      refs: [],
      actions: [
        { id: "comment", label: "Comment", outbound: true },
        { id: "open", label: "Open", outbound: false },
      ],
      updatedAt: new Date(now - i * 37 * 60000).toISOString(),
      unread: i < 2,
    }))
    .filter((item) => !filter.kind || item.kind === filter.kind)
    .filter((item) => !filter.source || item.source === filter.source);
}

/**
 * Sample event history for the browser preview, so the stats board can be
 * developed without the desktop app. Deterministic — a chart that reshuffles on
 * every reload is impossible to eyeball for layout bugs.
 */
function mockEvents(): EventRow[] {
  const rows: EventRow[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let id = 0;
  for (let day = 13; day >= 0; day--) {
    const base = Date.now() - day * 86_400_000;
    const weekend = [0, 6].includes(new Date(base).getDay());
    const push = (kind: string, extra: Partial<EventRow> = {}) => {
      rows.push({
        id: id++,
        ts: new Date(base - Math.floor(rand() * 6 * 3_600_000)).toISOString(),
        kind,
        ...extra,
      });
    };
    for (let i = 0; i < (weekend ? 3 : 18 + Math.floor(rand() * 28)); i++) push("tab.switch");
    for (let i = 0; i < (weekend ? 1 : 2 + Math.floor(rand() * 5)); i++) {
      push("sync.fetch", { source: "github" });
    }
    for (let i = 0; i < (weekend ? 0 : 1 + Math.floor(rand() * 4)); i++) {
      const local = rand() < 0.45;
      const tokensIn = 900 + Math.floor(rand() * 3300);
      const tokensOut = 150 + Math.floor(rand() * 750);
      push("ai.mail.draft", {
        source: local ? "local" : "anthropic",
        project: "ddd",
        tokensIn,
        tokensOut,
        costMicros: local ? 0 : tokensIn * 5 + tokensOut * 25,
      });
    }
    for (let i = 0; i < Math.floor(rand() * 3); i++) push("item.comment", { source: "github" });
    if (!weekend && rand() < 0.7) push("project.launch", { source: "local" });
  }
  return rows;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "system",
  terminalApp: null,
  editor: null,
  launchCommand: "claude",
  defaultRefreshSeconds: 300,
  showShortcutHints: true,
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  ai: {
    defaultProvider: "anthropic",
    ollamaUrl: "http://localhost:11434",
    openaiCompatibleUrl: null,
    routing: {
      "mail.classify": "local",
      "thread.summarize": "local",
      "issue.tasks": "anthropic",
      "mail.draft": "anthropic",
      "code.propose_fix": "anthropic",
    },
    monthlyBudgetUsd: null,
    anthropicModel: "claude-opus-5",
    localModel: "llama3.1:8b",
    openaiModel: "",
    classifyMailLocally: false,
  },
  voice: {
    enabled: false,
    sttMode: "local",
    sttModel: "base",
    ttsEngine: "os",
    ttsVoice: null,
    microphone: null,
  },
  data: { statsLoggingEnabled: true },
  connections: [],
};

// --- API --------------------------------------------------------------------

export const ipc = {
  isNative: isNative,

  globalLoad(): Promise<Global> {
    if (!isNative) return Promise.resolve(mem.read("global", MOCK_GLOBAL));
    return shared("global_load");
  },

  globalAppearanceSave(appearance: AppearanceSettings): Promise<Global> {
    if (!isNative) {
      const next = { ...mem.read("global", MOCK_GLOBAL), appearance };
      mem.write("global", next);
      return Promise.resolve(next);
    }
    return call("global_appearance_save", { appearance });
  },

  environmentCreate(id: string, name: string, color: string): Promise<Global> {
    if (!isNative) {
      const g = mem.read("global", MOCK_GLOBAL);
      g.environments.push({ id, name, color, hidden: false });
      mem.write("global", g);
      return Promise.resolve(g);
    }
    return call("environment_create", { id, name, color });
  },

  environmentUpdate(
    id: string,
    patch: { name?: string; color?: string; hidden?: boolean; collapsed?: boolean },
  ): Promise<Global> {
    if (!isNative) {
      const g = mem.read("global", MOCK_GLOBAL);
      const e = g.environments.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
      mem.write("global", g);
      return Promise.resolve(g);
    }
    return call("environment_update", { id, ...patch });
  },

  environmentSetActive(id: string): Promise<Global> {
    if (!isNative) {
      const g = mem.read("global", MOCK_GLOBAL);
      g.activeEnvironmentId = id;
      mem.write("global", g);
      return Promise.resolve(g);
    }
    return call("environment_set_active", { id });
  },

  environmentDelete(id: string): Promise<Global> {
    if (!isNative) {
      const g = mem.read("global", MOCK_GLOBAL);
      g.environments = g.environments.filter((e) => e.id !== id);
      if (g.activeEnvironmentId === id) g.activeEnvironmentId = g.environments[0]!.id;
      mem.write("global", g);
      return Promise.resolve(g);
    }
    return call("environment_delete", { id });
  },

  layoutLoad(env: string): Promise<Layout> {
    if (!isNative) return Promise.resolve(mem.read(`layout:${env}`, mockLayout()));
    return shared("layout_load", { env });
  },

  layoutSave(env: string, layout: Layout): Promise<void> {
    if (!isNative) {
      mem.write(`layout:${env}`, layout);
      return Promise.resolve();
    }
    return call("layout_save", { env, layout });
  },

  settingsLoad(env: string): Promise<Settings> {
    if (!isNative) return Promise.resolve(mem.read(`settings:${env}`, DEFAULT_SETTINGS));
    return shared("settings_load", { env });
  },

  settingsSave(env: string, settings: Settings): Promise<void> {
    if (!isNative) {
      mem.write(`settings:${env}`, settings);
      return Promise.resolve();
    }
    return call("settings_save", { env, settings });
  },

  // One keymap for the whole app — shortcuts are muscle memory, and having them
  // differ per environment would make the wall between two worlds show up in
  // your fingers.
  keymapLoad(): Promise<Record<string, string[]> | null> {
    if (!isNative) return Promise.resolve(mem.read("keymap", null));
    return call("keymap_load");
  },

  keymapSave(keymap: Record<string, string[]>): Promise<void> {
    if (!isNative) {
      mem.write("keymap", keymap);
      return Promise.resolve();
    }
    return call("keymap_save", { keymap });
  },

  projectsList(env: string): Promise<Project[]> {
    if (!isNative) return Promise.resolve(mem.read(`projects:${env}`, [] as Project[]));
    return shared("projects_list", { env });
  },

  projectRegister(env: string, path: string): Promise<Project> {
    if (!isNative) return Promise.reject(new Error("Registering projects needs the desktop app"));
    return call("project_register", { env, path });
  },

  projectUnregister(env: string, id: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("project_unregister", { env, id });
  },

  calendarList(env: string, from: string, to: string): Promise<Occurrence[]> {
    if (!isNative) return Promise.resolve(mem.read(`calendar:${env}:occurrences`, [] as Occurrence[]));
    return shared("calendar_list", { env, from, to });
  },

  calendarEventSave(env: string, event: LocalEvent): Promise<LocalEvent> {
    if (!isNative) return Promise.reject(new Error("Saving events needs the desktop app"));
    return call("calendar_event_save", { env, event });
  },

  calendarEventDelete(env: string, id: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("calendar_event_delete", { env, id });
  },

  pathExists(path: string): Promise<boolean> {
    if (!isNative) return Promise.resolve(true);
    return call("path_exists", { path });
  },

  launchPath(path: string): Promise<void> {
    if (!isNative) return Promise.reject(new Error("Launching a terminal needs the desktop app"));
    return call("launch_path", { path });
  },

  editorsList(): Promise<FoundApp[]> {
    if (!isNative) return Promise.resolve([]);
    return call("editors_list");
  },

  terminalsList(): Promise<FoundApp[]> {
    if (!isNative) return Promise.resolve([]);
    return call("terminals_list");
  },

  openInEditor(path: string, editor?: string): Promise<void> {
    if (!isNative) return Promise.reject(new Error("Opening an editor needs the desktop app"));
    return call("open_in_editor", { path, editor });
  },

  projectReload(env: string, id: string): Promise<Project> {
    return call("project_reload", { env, id });
  },

  /** Opens the configured terminal in the project and starts Claude Code. */
  projectLaunch(env: string, id: string): Promise<void> {
    if (!isNative) return Promise.reject(new Error("Launching needs the desktop app"));
    return call("project_launch", { env, id });
  },

  /**
   * Subscribe to `.ddd/` changes. The Rust watcher fires this when `/todo` or
   * the SessionEnd hook writes, so a capture made inside Claude Code shows up
   * on the board without anyone refreshing anything.
   */
  async onProjectChanged(
    handler: (payload: { environmentId: string; projectId: string }) => void,
  ): Promise<() => void> {
    if (!bridge) return () => {};
    return bridge.on("ddd://project-changed", (payload) =>
      handler(payload as { environmentId: string; projectId: string }),
    );
  },

  /**
   * Fire-and-forget by design: a dropped stat must never interrupt the action it
   * was measuring.
   */
  eventLog(env: string, event: EventInput): void {
    if (!isNative) return;
    void call("event_log", { env, event }).catch(() => {});
  },

  eventsQuery(
    env: string,
    opts: { since?: string; kindPrefix?: string; limit?: number } = {},
  ): Promise<EventRow[]> {
    if (!isNative) return Promise.resolve(mockEvents());
    return shared("events_query", { env, ...opts });
  },

  eventsClear(env: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("events_clear", { env });
  },

  /**
   * What every item widget reads. Deliberately cache-only: a widget cannot
   * trigger a fetch, so adding widgets never costs API quota.
   */
  itemsQuery(env: string, filter: ItemFilter): Promise<Item[]> {
    if (!isNative) return Promise.resolve(mockItems(filter));
    return shared("items_query", { env, filter });
  },

  /** Manual refresh. The scheduler owns the cadence; this is the nudge. */
  syncNow(env: string, connectionId?: string): Promise<number> {
    if (!isNative) return Promise.resolve(0);
    return call("sync_now", { env, connectionId: connectionId ?? null });
  },

  /**
   * The approval gate. Every outbound action goes through here, and it is only
   * ever called from an explicit click or keypress — never from the AI layer.
   */
  itemAction(env: string, itemId: string, action: string, input?: string): Promise<string> {
    if (!isNative) return Promise.reject(new Error("Actions need the desktop app"));
    return call("item_action", { env, itemId, action, input: input ?? null });
  },

  async onItemsChanged(handler: (payload: { environmentId: string }) => void): Promise<() => void> {
    if (!bridge) return () => {};
    return bridge.on("ddd://items-changed", (payload) =>
      handler(payload as { environmentId: string }),
    );
  },

  async openExternal(url: string): Promise<void> {
    if (!isNative) {
      window.open(url, "_blank", "noopener");
      return;
    }
    await call("open_external", { url });
  },

  /**
   * Show a folder in the OS file manager.
   *
   * `revealItemInDir` rather than opening a path as a URL: this is a directory
   * on disk, and handing it to the browser would be both wrong and a way to
   * open something that is not a folder.
   */
  async revealPath(path: string): Promise<void> {
    if (!isNative) return;
    await call("reveal_path", { path });
  },

  /**
   * Run the OAuth consent flow. Opens the system browser and waits on a
   * loopback listener — the token never passes through this webview.
   */
  connectionConnect(env: string, connectionId: string): Promise<void> {
    if (!isNative) return Promise.reject(new Error("Connecting needs the desktop app"));
    return call("connection_connect", { env, connectionId });
  },

  connectionUsesOauth(provider: string): Promise<boolean> {
    if (!isNative) return Promise.resolve(["mail.gmail", "slack"].includes(provider));
    return call("connection_uses_oauth", { provider });
  },

  aiActionsFor(env: string, itemId: string): Promise<AiActionInfo[]> {
    // The stand-in offers one, so the AI row — and the provenance control
    // beside it — can be built without a Tauri window.
    if (!isNative)
      return Promise.resolve([
        { id: "thread.summarize", label: "Summarize", target: "panel" } as AiActionInfo,
      ]);
    return call("ai_actions_for", { env, itemId });
  },

  /**
   * Produce a proposal. This never sends anything — the result lands in the
   * composer, and a human presses Send, which is the approval gate.
   */
  aiDraft(env: string, itemId: string, action: string): Promise<AiDraft> {
    if (!isNative) return Promise.reject(new Error("AI actions need the desktop app"));
    return call("ai_draft", { env, itemId, action });
  },

  secretSet(env: string, key: string, value: string): Promise<void> {
    return call("secret_set", { env, key, value });
  },

  /** Status only — there is deliberately no way to read a secret back out. */
  secretExists(env: string, key: string): Promise<boolean> {
    if (!isNative) return Promise.resolve(false);
    return call("secret_exists", { env, key });
  },

  secretDelete(env: string, key: string): Promise<void> {
    return call("secret_delete", { env, key });
  },

  pathsInfo(env: string): Promise<PathsInfo> {
    if (!isNative) {
      return Promise.resolve({
        home: "(browser preview — no filesystem)",
        environmentDir: "",
        settingsFile: "",
        layoutFile: "",
        keymapFile: "",
        projectsFile: "",
        eventsDb: "",
      });
    }
    return call("paths_info", { env });
  },

  /** Ask where to write a file, then write it. Returns the path, or null. */
  async saveTextFile(suggestedName: string, contents: string): Promise<string | null> {
    if (!isNative) {
      // In a browser, a download is the closest honest equivalent.
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      a.click();
      URL.revokeObjectURL(url);
      return suggestedName;
    }
    const path = await call<string | null>("dialog_save", { suggestedName });
    if (!path) return null;
    // Main writes it. The webview picks the path and never touches the disk —
    // the same reason connect-src is what it is.
    await call("layout_file_write", { path, contents });
    return path;
  },

  /** Ask for a file and read it. Returns its text, or null if cancelled. */
  async openTextFile(): Promise<string | null> {
    if (!isNative) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return resolve(null);
          void file.text().then(resolve);
        };
        input.click();
      });
    }
    const picked = await call<string | null>("dialog_open_file");
    if (!picked) return null;
    return call("layout_file_read", { path: picked });
  },

  async pickDirectory(): Promise<string | null> {
    if (!isNative) return null;
    return call<string | null>("dialog_pick_directory");
  },

  reposList(env: string, filter: { scope?: string; query?: string }): Promise<RepoListing> {
    if (!isNative) return Promise.resolve(mem.read(`repos:${env}`, MOCK_REPOS));
    return shared("repos_list", { env, filter });
  },

  widgetInstructionsLoad(env: string, widgetId: string): Promise<Instructions> {
    if (!isNative)
      return Promise.resolve(
        mem.read(`instructions:${env}:${widgetId}`, {
          text: "",
          hash: "",
          path: "",
          exists: false,
        }),
      );
    return call("widget_instructions_load", { env, widgetId });
  },

  widgetInstructionsSave(env: string, widgetId: string, text: string): Promise<Instructions> {
    if (!isNative) {
      const saved = { text, hash: String(text.length), path: "", exists: true };
      mem.write(`instructions:${env}:${widgetId}`, saved);
      return Promise.resolve(saved);
    }
    return call("widget_instructions_save", { env, widgetId, text });
  },

  widgetInstructionsClear(env: string, widgetId: string): Promise<void> {
    if (!isNative) {
      mem.write(`instructions:${env}:${widgetId}`, { text: "", hash: "", path: "", exists: false });
      return Promise.resolve();
    }
    return call("widget_instructions_clear", { env, widgetId });
  },

  widgetInstructionsTemplate(kind: string): Promise<string> {
    if (!isNative) return Promise.resolve("");
    return call("widget_instructions_template", { kind });
  },

  /** Compile once, with a local model. Rejects on every failure; the caller
   *  keeps its last good filter rather than losing one. */
  widgetInstructionsCompile(env: string, widgetId: string, kind: string): Promise<Compiled> {
    if (!isNative) return Promise.reject(new Error("compilation needs the desktop app"));
    return call("widget_instructions_compile", { env, widgetId, kind });
  },

  /** Record approval for this exact command. Returns the token to store. */
  mcpConsent(command: string): Promise<string> {
    if (!isNative) return Promise.reject(new Error("approval needs the desktop app"));
    return call("mcp_consent", { command });
  },

  mcpProbe(env: string, connectionId: string): Promise<McpReport> {
    if (!isNative) return Promise.reject(new Error("this needs the desktop app"));
    return call("mcp_probe", { env, connectionId });
  },

  /** Read-only: what an AI action on this item would be given. No model runs. */
  aiContextFor(env: string, itemId: string): Promise<AiContext> {
    if (!isNative) return Promise.resolve(MOCK_CONTEXT);
    return call("ai_context_for", { env, itemId });
  },

  // --- Products -------------------------------------------------------------

  productsList(env: string): Promise<Product[]> {
    if (!isNative) return Promise.resolve(MOCK_PRODUCTS);
    return shared("products_list", { env });
  },

  /**
   * Approve this exact command, in this exact directory.
   *
   * The command is passed rather than re-read on the Rust side: approving what
   * is on screen is the whole point, and a config file that changed between the
   * render and the click must not be approved unseen.
   */
  productApprove(env: string, key: string, run: string, dir: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("product_approve", { env, key, run, dir });
  },

  productRevoke(env: string, key: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("product_revoke", { env, key });
  },

  productStart(env: string, key: string, run: string, dir: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("product_start", { env, key, run, dir });
  },

  productStop(env: string, key: string): Promise<ProductState> {
    if (!isNative) return Promise.resolve({ state: "stopped" });
    return call("product_stop", { env, key });
  },

  productLog(env: string, key: string): Promise<string> {
    if (!isNative) return Promise.resolve("");
    return call("product_log", { env, key });
  },

  eolBoard(env: string): Promise<EolBoard> {
    if (!isNative) return Promise.resolve(mem.read(`eol:${env}`, { rows: [], stale: [] }));
    return shared("eol_board", { env });
  },

  eolWatch(env: string, path: string, url?: string, note?: string): Promise<Watchlist> {
    if (!isNative) return Promise.resolve({ watched: [] });
    return call("eol_watch", { env, path, url, note });
  },

  eolUnwatch(env: string, path: string): Promise<Watchlist> {
    if (!isNative) return Promise.resolve({ watched: [] });
    return call("eol_unwatch", { env, path });
  },

  eolWatchlist(env: string): Promise<Watchlist> {
    if (!isNative) return Promise.resolve({ watched: [] });
    return call("eol_watchlist", { env });
  },

  devServersList(env: string, filter: DevServerFilter): Promise<DevServerListing> {
    if (!isNative)
      return Promise.resolve(
        mem.read(`devservers:${env}`, {
          rows: [],
          hidden: 0,
          foreignCount: 0,
          scanMs: 0,
          partial: false,
        }),
      );
    return shared("dev_servers_list", { env, filter });
  },

  devServerProbe(address: string, port: number, http: boolean): Promise<DevProbe> {
    if (!isNative)
      return Promise.resolve({ health: "unknown", latencyMs: null, checkedAt: "" });
    return call("dev_server_probe", { address, port, http });
  },

  /** SIGTERM behind the reuse guard. Rejects with the refusal's own sentence. */
  devServerStop(env: string, key: string, pid: number, process: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("dev_server_stop", { env, key, pid, process });
  },

  repoScan(env: string, rootDir: string): Promise<number> {
    if (!isNative) return Promise.resolve(0);
    return call("repo_scan", { env, rootDir });
  },

  repoLink(env: string, remote: string, path: string): Promise<void> {
    if (!isNative) return Promise.reject(new Error("Linking repos needs the desktop app"));
    return call("repo_link", { env, remote, path });
  },

  repoAddLocal(env: string, path: string): Promise<void> {
    if (!isNative) return Promise.reject(new Error("Adding a local repo needs the desktop app"));
    return call("repo_add_local", { env, path });
  },

  repoForget(env: string, path: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("repo_forget", { env, path });
  },

  repoUnlink(env: string, remote: string): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("repo_unlink", { env, remote });
  },

  repoClone(env: string, remote: string, cloneUrl: string, parentDir: string): Promise<string> {
    if (!isNative) return Promise.reject(new Error("Cloning needs the desktop app"));
    return call("repo_clone", { env, remote, cloneUrl, parentDir });
  },

  /**
   * Subscribe to clone progress. Mirrors `onProjectChanged`: browser preview
   * has no clone to report on, so the fallback is a no-op unsubscribe.
   */
  async onRepoProgress(
    handler: (p: { remote: string; phase: string; percent: number; done: boolean; error?: string | null }) => void,
  ): Promise<() => void> {
    if (!bridge) return () => {};
    return bridge.on("ddd://repo-progress", (payload) =>
      handler(
        payload as { remote: string; phase: string; percent: number; done: boolean; error?: string | null },
      ),
    );
  },

  /** What landed in a repo since a timestamp — the sitrep widget's git delta. */
  repoChangesSince(env: string, path: string, since: string): Promise<{ commits: number; filesChanged: number; messages: string[] }> {
    if (!isNative) return Promise.resolve({ commits: 0, filesChanged: 0, messages: [] });
    return call("repo_changes_since", { env, path, since });
  },

  /** The per-tab "what happened while I was away" summary, once, with a local
   *  model by default. Rejects on every failure; the caller falls back to its
   *  deterministic digest. */
  tabSitrepGenerate(env: string, input: unknown): Promise<{ text: string; model: string }> {
    if (!isNative) return Promise.resolve({ text: "", model: "" });
    return call("tab_sitrep_generate", { env, input });
  },
};
