/**
 * The IPC contract: one entry per command, naming the fields the renderer
 * sends and what main checks before the handler runs. Both sides read this
 * table — `ipc.call` in the renderer is typed by it and `parseArgs` in main
 * validates against it — so a field renamed or retyped on one side fails to
 * compile on the other.
 *
 * `json` is a document the command parses itself (a layout, a filter, an
 * event); the table only checks that it is present. A trailing `?` makes a
 * field optional; null and absence both mean "not given".
 */
export const COMMANDS = {
  // environments and the global file
  global_load: {},
  global_appearance_save: { appearance: "json" },
  global_wizard_save: { completed: "boolean", step: "number?" },
  environment_create: { id: "string", name: "string", color: "string" },
  environment_update: { id: "string", name: "string?", color: "string?", hidden: "boolean?", collapsed: "boolean?" },
  environment_set_active: { id: "string" },
  environment_delete: { id: "string" },

  // per-environment files
  layout_load: { env: "string" },
  layout_save: { env: "string", layout: "json" },
  layout_file_write: { path: "string", contents: "string" },
  layout_file_read: { path: "string" },
  settings_load: { env: "string" },
  settings_save: { env: "string", settings: "json" },
  keymap_load: {},
  keymap_save: { keymap: "json" },

  // events
  event_log: { env: "string", event: "json" },
  events_query: { env: "string", since: "string?", kindPrefix: "string?", limit: "number?" },
  events_clear: { env: "string" },

  // secrets and paths
  secret_set: { env: "string", key: "string", value: "string" },
  secret_exists: { env: "string", key: "string" },
  secret_delete: { env: "string", key: "string" },
  paths_info: { env: "string" },
  path_exists: { path: "string" },

  // projects and launching
  projects_list: { env: "string" },
  project_register: { env: "string", path: "string" },
  project_unregister: { env: "string", id: "string" },
  project_reload: { env: "string", id: "string" },
  project_launch: { env: "string", id: "string" },
  launch_path: { path: "string" },
  editors_list: {},
  terminals_list: {},
  open_in_editor: { path: "string", editor: "string?" },

  // items, sync, connections
  items_query: { env: "string", filter: "json?" },
  cache_clear: { env: "string" },
  sync_now: { env: "string", connectionId: "string?" },
  item_action: { env: "string", itemId: "string", action: "string", input: "string?" },
  connection_connect: { env: "string", connectionId: "string" },
  connection_uses_oauth: { provider: "string" },

  // AI
  ai_actions_for: { env: "string", itemId: "string" },
  ai_context_for: { env: "string", itemId: "string" },
  ai_draft: { env: "string", itemId: "string", action: "string" },
  widget_instructions_load: { env: "string", widgetId: "string" },
  widget_instructions_save: { env: "string", widgetId: "string", text: "string" },
  widget_instructions_clear: { env: "string", widgetId: "string" },
  widget_instructions_template: { kind: "string" },
  widget_instructions_compile: { env: "string", widgetId: "string", kind: "string" },
  tab_sitrep_generate: { env: "string", input: "json" },

  // calendar
  calendar_list: { env: "string", from: "string", to: "string" },
  calendar_event_save: { env: "string", event: "json" },
  calendar_event_delete: { env: "string", id: "string" },

  // repositories
  repos_list: { env: "string", filter: "json?" },
  repo_scan: { env: "string", rootDir: "string" },
  repo_link: { env: "string", remote: "string", path: "string" },
  repo_add_local: { env: "string", path: "string" },
  repo_forget: { env: "string", path: "string" },
  repo_unlink: { env: "string", remote: "string" },
  repo_clone: { env: "string", remote: "string", cloneUrl: "string", parentDir: "string" },
  repo_changes_since: { env: "string", path: "string", since: "string" },

  // dev servers
  dev_servers_list: { env: "string", filter: "json?" },
  dev_server_probe: { address: "string", port: "number", http: "boolean" },
  dev_server_stop: { env: "string", key: "string", pid: "number", process: "string" },

  // end of life
  eol_board: { env: "string" },
  eol_watch: { env: "string", path: "string", url: "string?", note: "string?" },
  eol_unwatch: { env: "string", path: "string" },
  eol_watchlist: { env: "string" },

  // products
  products_list: { env: "string" },
  product_approve: { env: "string", key: "string", run: "string", dir: "string" },
  product_revoke: { env: "string", key: "string" },
  product_start: { env: "string", key: "string", run: "string", dir: "string" },
  product_stop: { env: "string", key: "string" },
  product_log: { env: "string", key: "string" },

  // MCP
  mcp_consent: { command: "string" },
  mcp_probe: { env: "string", connectionId: "string" },

  // media and local models
  media_state: {},
  media_command: { player: "string", action: "string", value: "number?" },
  models_scan: {},
  models_move: { id: "string", dest: "string" },

  // host: needs the window or the shell, handled in main/ipc.ts
  dialog_save: { suggestedName: "string" },
  dialog_open_file: {},
  dialog_pick_directory: {},
  open_external: { url: "string" },
  reveal_path: { path: "string" },
  window_set_zoom: { factor: "number" },
} as const satisfies Record<string, Record<string, Field>>;

export type Field = "string" | "string?" | "number" | "number?" | "boolean" | "boolean?" | "json" | "json?";

/** The commands that need the window or the shell rather than the core. */
export const HOST_COMMANDS = [
  "dialog_save",
  "dialog_open_file",
  "dialog_pick_directory",
  "open_external",
  "reveal_path",
  "window_set_zoom",
] as const;

export type CommandName = keyof typeof COMMANDS;
export type HostCommand = (typeof HOST_COMMANDS)[number];
export type CoreCommand = Exclude<CommandName, HostCommand>;

type Shape<K extends CommandName> = (typeof COMMANDS)[K];
type Optional<F> = F extends `${string}?` ? true : false;
type Base<F> =
  F extends "string" | "string?" ? string
  : F extends "number" | "number?" ? number
  : F extends "boolean" | "boolean?" ? boolean
  : unknown;

/** What the renderer sends: optional fields may be omitted or null. */
export type CommandArgs<K extends CommandName> = {
  [F in keyof Shape<K> as Optional<Shape<K>[F]> extends true ? never : F]: Base<Shape<K>[F]>;
} & {
  [F in keyof Shape<K> as Optional<Shape<K>[F]> extends true ? F : never]?: Base<Shape<K>[F]> | null;
};

/** What a handler receives after `parseArgs`: optional fields are undefined when not given. */
export type ParsedArgs<K extends CommandName> = {
  [F in keyof Shape<K>]: Optional<Shape<K>[F]> extends true ? Base<Shape<K>[F]> | undefined : Base<Shape<K>[F]>;
};
