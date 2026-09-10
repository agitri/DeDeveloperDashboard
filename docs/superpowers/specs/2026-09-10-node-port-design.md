# DDD on Node.js — design

**Date:** 2026-09-10
**Source:** `../DDD` at commit `7fe0f68` (Tauri 2 + Rust backend, React/TypeScript frontend)
**Target:** `nodeDDD` — an Electron app whose backend is a TypeScript port of the Rust

## 1. Goal

Rebuild DDD (De Developer Dashboard) as a Node.js application with full feature
parity, delivered in phases. The frontend is already React/TypeScript and is
carried over; the Rust backend (about 20k lines behind 71 IPC commands) is
ported one module at a time to TypeScript running in Electron's main process.

Both apps read and write the same `~/.ddd` directory, the same SQLite schemas
and the same keychain entries, so the two can be run against the same data
while the port is in progress.

### Non-goals

- Changing product behaviour. Where the Rust does something odd, the port does
  the same odd thing and leaves a comment. Behaviour changes are separate work.
- Redesigning the frontend. It is copied, and `src/lib/ipc.ts` is rewired.
- Mobile, hosted or multi-user editions.
- Supporting Electron's own auto-update, telemetry or crash reporting. DDD's
  zero-telemetry claim carries over.

## 2. Context

DDD is a local-first developer dashboard: tabs of widgets over one normalized
`Item` model, fed by a single sync scheduler, with AI helpers that draft but
never send. The architectural commitments the port must keep, in the source
project's own words, are in `../DDD/docs/ARCHITECTURE.md`:

- a hexagonal core with one canonical `Item`;
- `EnvRoot` as a capability — nothing reaches for `~/.ddd` directly;
- a read/write split: `items_query` reads the cache and cannot fetch; the
  scheduler is the cache's only writer; `item_action` is the only outbound path;
- secrets are write/status only from the UI; no command reads one back;
- events flow one way, backend to webview, for cache invalidation only.

Sizes at HEAD:

| Part | Lines | Notes |
|---|---|---|
| Rust backend | ~19.7k | 71 registered commands, 49 modules |
| Frontend | ~16.5k | touches Tauri in `lib/ipc.ts` and one line of `RepoWidget.tsx` |
| `products/` | ~0.8k | landed in DDD on 2026-09-10 (`7fe0f68`); ported in the last phase |

## 3. Architecture

One package, built with electron-vite. Four source trees, one rule:

```
nodeDDD/
  src/
    core/        the port of src-tauri/src — MUST NOT import "electron"
    main/        Electron host: window, command registry, dialogs, events
    preload/     contextBridge: window.ddd.invoke / window.ddd.on
    renderer/    the DDD frontend, copied from ../DDD/src
  docs/          this spec, plans, and the DDD docs that still apply
  claude-code/   install.sh, bin/, commands/, hooks/ — copied verbatim
```

Layering, top to bottom, unchanged from the Rust:

```
renderer components → zustand stores → lib/ipc.ts
        ── IPC boundary (preload) ──
main/commands.ts      thin: resolve EnvRoot, delegate, return
core/<service>        sync/scheduler · projects · launcher · watcher · ai
core/<repository>     sync/cache (SQLite) · store (JSON) · secrets · events
core/<adapter>        github · jira · google · slack · ics · imap · mcp · mock
```

`core/` is a plain Node library. It is tested with vitest and no Electron, and
a contract test fails the build if any file under it imports `electron`. Where
the Rust took an `AppHandle` to emit an event, the TypeScript takes an `Emitter`
interface (`emit(name, payload)`) that main implements with `webContents.send`
and tests implement with an array.

### 3.1 Host (`src/main`)

- `index.ts` — creates the `BrowserWindow` (1360×860, min 900×560, hidden
  title with overlay controls on macOS), runs `bootstrap()`, starts the
  scheduler loop, registers commands.
- `commands.ts` — a `Record<string, Handler>` keyed by the Tauri command name.
  One `ipcMain.handle("ddd:invoke", (cmd, args))` dispatches into it. Unknown
  command → rejected promise. Errors are rejected as their message string, which
  is what the Tauri `Error` serialized to.
- `ipc.ts` — the `ddd:invoke` channel and the five commands that used to be
  Tauri plugins: `dialog_save`, `dialog_open_file`, `dialog_pick_directory`,
  `open_external`, `reveal_path`.
- `csp.ts` — the same policy `tauri.conf.json` ships, applied through
  `session.webRequest.onHeadersReceived`, with a test pinning it exactly as
  `lib.rs` pins the Tauri one.

Electron security settings: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`, navigation and `window.open` blocked, and
`open_external` refuses anything that is not `http:` or `https:`.

### 3.2 Bridge (`src/preload`)

```ts
contextBridge.exposeInMainWorld("ddd", {
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("ddd:invoke", cmd, args ?? {}),
  on: (event: string, handler: (payload: unknown) => void) => {
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.off(event, wrapped);
  },
});
```

Event names stay `ddd://project-changed`, `ddd://items-changed`,
`ddd://repo-progress`, with the same payloads.

### 3.3 Frontend changes (`src/renderer`)

A copy of `../DDD/src`, plus `index.html`, `public/`, styles and fonts. The
diff against the source is limited to:

1. `lib/ipc.ts`: `inTauri` becomes `isNative = "ddd" in window`; `call` uses
   `window.ddd.invoke`; the three `listen` calls use `window.ddd.on`; the dialog
   and opener plugin imports become calls to the five host commands.
2. `widgets/RepoWidget.tsx:606`: the direct `plugin-opener` import becomes
   `ipc.revealPath`.
3. `lib/ipc.coalesce.test.ts`: mocks `window.ddd` instead of `@tauri-apps/api`.
4. `vite-env.d.ts`: declares `window.ddd`.
5. Dependencies: the three `@tauri-apps/*` packages are dropped.

The localStorage stand-in stays as is, so `npm run dev` (Vite only, no
Electron) remains the fast loop for widget and layout work.

## 4. IPC contract

Command names and argument keys are the Tauri ones (camelCase on the wire, as
Tauri already converted them). `env` is always an environment id, narrowed to an
`EnvRoot` first. Grouped by phase:

**Phase 0 — shell.** `global_load`, `global_appearance_save`,
`environment_create`, `environment_update`, `environment_set_active`,
`environment_delete`, `layout_load`, `layout_save`, `layout_file_write`,
`layout_file_read`, `settings_load`, `settings_save`, `keymap_load`,
`keymap_save`, `event_log`, `events_query`, `events_clear`, `secret_set`,
`secret_exists`, `secret_delete`, `paths_info`, `path_exists`; host:
`dialog_save`, `dialog_open_file`, `dialog_pick_directory`, `open_external`,
`reveal_path`.

**Phase 1 — projects.** `projects_list`, `project_register`,
`project_unregister`, `project_reload`, `project_launch`, `launch_path`,
`open_in_editor`, `editors_list`, `terminals_list`; event
`ddd://project-changed`.

**Phase 2 — sync.** `items_query`, `sync_now`, `item_action`, `cache_clear`,
`connection_connect`, `connection_uses_oauth`; event `ddd://items-changed`.

**Phase 3 — AI and instructions.** `ai_actions_for`, `ai_draft`,
`ai_context_for`, `widget_instructions_load`, `widget_instructions_save`,
`widget_instructions_clear`, `widget_instructions_template`,
`widget_instructions_compile`.

**Phase 4 — calendar, repos, dev servers, EOL.** `calendar_list`,
`calendar_event_save`, `calendar_event_delete`, `repos_list`, `repo_scan`,
`repo_link`, `repo_unlink`, `repo_add_local`, `repo_forget`, `repo_clone`
(event `ddd://repo-progress`), `dev_servers_list`, `dev_server_probe`,
`dev_server_stop`, `eol_board`, `eol_watch`, `eol_unwatch`, `eol_watchlist`.

**Phase 5 — remaining adapters.** No new commands; `mcp_consent` and
`mcp_probe` land here with the MCP adapter.

**Phase 6 — products.** `product_approve`, `product_revoke`, `product_start`,
`product_stop`, `products_list`, `product_log`, as landed in DDD commit `7fe0f68`.

A contract test reads `../DDD/src-tauri/src/lib.rs` when that path exists and
asserts every name in `generate_handler![...]` is registered, so drift in the
source shows up as a failing test here rather than a blank widget.

## 5. Core module map

Same file names, same responsibilities, same public function names in
camelCase. Rust `Result<T, Error>` becomes a thrown `DddError` with the same
seven kinds (`io`, `json`, `sqlite`, `keychain`, `config`, `notFound`,
`invalid`) and the same message text, because the frontend shows those
messages.

| Rust | TypeScript | Library |
|---|---|---|
| `paths.rs` | `core/paths.ts` — `dddHome()`, `EnvRoot`, `DddFolder`, `validateEnvId` | `node:path`, `node:os` |
| `store.rs` | `core/store.ts` — `readJson`, `readJsonOpt`, `writeJson` (tmp + rename) | `node:fs` |
| `error.rs` | `core/error.ts` | — |
| `models.rs` | `core/models.ts` — re-exports `renderer/types` where identical, adds the backend-only shapes | — |
| `settings.rs` | `core/settings.ts` — defaults, `Connection`, `ConnectionStatus` | — |
| `events.rs` | `core/events.ts` — same table, same indexes, WAL | `node:sqlite` |
| `secrets.rs` | `core/secrets.ts` — service `ddd:<env>`; `get` not exported from the command layer | `@napi-rs/keyring` |
| `projects.rs` | `core/projects.ts` — registry, `git status` parsing, `.ddd/` reading | `node:child_process` |
| `launcher.rs` | `core/launcher.ts` — terminal templates, macOS `open -a`, Windows `wt`/`cmd`, Linux candidates | `node:child_process` |
| `watcher.rs` | `core/watcher.ts` — union of roots, 400 ms debounce, one event per project per burst | `node:fs` `watch` (recursive) |
| `sync/adapter.rs` | `core/sync/adapter.ts` — `SourceAdapter` interface, `forProvider`, `itemId` | — |
| `sync/cache.rs` | `core/sync/cache.ts` — same schema, snapshot replace in one transaction | `node:sqlite` |
| `sync/scheduler.rs` | `core/sync/scheduler.ts` — 20 s tick, due/mark/invalidate, `syncConnection` | `setInterval` |
| `sync/github.rs` | `core/sync/github.ts` — one GraphQL call + notifications | `fetch` |
| `sync/oauth.rs` | `core/sync/oauth.ts` — loopback listener + PKCE, refresh | `node:http`, `node:crypto` |
| `sync/mock.rs` | `core/sync/mock.ts` | — |
| `sync/signal.rs`, `classify.rs` | `core/sync/signal.ts`, `classify.ts` — pure scoring, ported with their tests | — |
| `sync/google.rs` | `core/sync/google.ts` — Gmail + Calendar | `fetch` |
| `sync/ics.rs`, `calendar/*` | `core/sync/ics.ts`, `core/calendar/*` — parse, expand recurrences | `rrule` |
| `sync/imap.rs` | `core/sync/imap.ts` | `imapflow`, `postal-mime` |
| `sync/jira.rs`, `slack.rs` | `core/sync/jira.ts`, `slack.ts` | `fetch` |
| `sync/mcp/*` | `core/sync/mcp/{adapter,map,consent}.ts` | `@modelcontextprotocol/sdk` (stdio client) |
| `ai/provider.rs` | `core/ai/provider.ts` — `LLMProvider` port, pricing table | — |
| `ai/anthropic.rs`, `local.rs` | `core/ai/anthropic.ts`, `local.ts` | `fetch` |
| `ai/icm.rs`, `actions.rs`, `router.rs` | same names | — |
| `instructions.rs` | `core/instructions.ts` | — |
| `repos/*` | `core/repos/{scan,links,remote,clone}.ts` | `git` via `child_process` |
| `dev/*` | `core/dev/{listen,cwd,probe,containers,stop}.ts` — `lsof -iTCP -sTCP:LISTEN -P -n -F` on macOS/Linux, `netstat -ano` on Windows, `process.kill(pid, "SIGTERM")` | `node:child_process`, `node:net` |
| `eol/*` | `core/eol/{detect,status,schedule,live,watchlist}.ts` | `fetch` |
| `products/*` | `core/products/*` | `node:child_process` |
| `commands.rs` | `main/commands.ts` | — |
| `lib.rs` `bootstrap`, `starter_layout` | `core/bootstrap.ts` | — |
| `verify.rs` | `core/verify.test.ts`, skipped unless `DDD_VERIFY=1` | — |

Library choices and why:

- **`node:sqlite`** rather than `better-sqlite3`: Electron 44 bundles Node
  24.20, so it is built in and needs no native rebuild against Electron's ABI.
- **`@napi-rs/keyring`** wraps the same Rust `keyring` crate the Tauri app uses,
  so entries written by either app are readable by the other. Its prebuilt
  N-API binary works under Electron without a rebuild.
- **`node:fs` `watch({ recursive: true })`** is supported on macOS, Windows and
  Linux in Node 24. chokidar is the fallback if it proves unreliable on Linux.
- **`@modelcontextprotocol/sdk`** replaces about 1.5k lines of hand-rolled
  JSON-RPC and stdio framing in the Rust. The adapter, item mapping and consent
  token logic are still ported.
- **`fetch`** (undici) for everything HTTP; one shared 30 s timeout via
  `AbortSignal.timeout`.

## 6. On-disk compatibility

Byte-for-byte the same layout, so the two apps can share a home:

```
~/.ddd/                          or $DDD_HOME
  global.json                    environments + active + appearance
  keymap.json                    one keymap for the whole app
  environments/<env>/
    settings.json layout.json keymap.json projects.json
    repo-links.json calendar.json watchlist.json eol-cache.json
    products.json product-approvals.json products/
    events.sqlite cache.sqlite
```

JSON is pretty-printed with two-space indent, written to `<file>.json.tmp` then
renamed. SQLite tables, columns and indexes are created with the same DDL as
the Rust. Keychain service is `ddd:<env>`, account is the secret key.

`DDD_HOME` is honoured, and every test sets it to a fresh temp directory.
Because it is process-global, tests that construct an `EnvRoot` run through a
`scratchEnv()` helper that serialises access, as the Rust `testing` module does.

## 7. Error handling

- Core throws `DddError`. Main catches, rejects with `error.message`. The
  renderer already treats a rejected invoke as a string.
- Scheduler failures are recorded on the connection (`status`, `error`,
  `lastSyncAt`) and logged to stderr, never thrown out of the loop.
- The watcher swallows per-path errors and keeps the other watches alive.
- Adapter HTTP errors carry the status code in the message, because the
  scheduler matches on `401`/`403` to mark a connection expired.

## 8. Testing

- **Unit:** every `#[cfg(test)]` block becomes a `.test.ts` beside its module.
  vitest with `environment: node` for all tests; the renderer tests stand up
  `window` themselves, as in DDD.
- **Contract:** `core/no-electron.test.ts` greps for `electron` imports under
  `core/`; `main/commands.test.ts` compares the registry with the Tauri
  handler list when `../DDD` is present; `main/csp.test.ts` pins the policy.
- **Renderer:** the existing tests are carried over and must pass unchanged
  except the coalescing test's mock.
- **Live checks:** `verify.rs`'s ignored tests become `DDD_VERIFY=1` tests,
  documented as the same honest table the README keeps.
- **Smoke:** `npm run dev:electron` boots to the starter board (clock, notes,
  projects) against a scratch `DDD_HOME`.

## 9. Phases

Each phase ends with the app runnable and its tests green.

0. **Shell.** Scaffold, bridge, CSP, `paths`/`store`/`error`/`models`/
   `settings`/`events`/`secrets`/`bootstrap`, phase-0 commands, frontend copied
   and rewired. Boots to the starter board.
1. **Projects.** `projects`, `launcher`, `watcher`, editors/terminals discovery.
   `/todo` in Claude Code reaches the card.
2. **Sync.** `adapter`, `cache`, `scheduler`, `oauth`, `github`, `mock`,
   `signal`, `classify`; the approval gate. GitHub items on the board.
3. **AI and instructions.** Providers, ICM, actions, router, widget
   instruction compilation.
4. **Calendar, repos, dev servers, EOL.**
5. **Remaining adapters.** Jira, Slack, Gmail/Calendar, IMAP, MCP.
6. **Products, packaging, scripts.** `products/*` re-read from DDD at that
   time; electron-builder targets for macOS, Windows, Linux; `claude-code/`
   copied and its installer checked.

## 10. Risks and open items

- **`node:sqlite` in the renderer build chain.** It is main-process only; the
  vite config for main must mark `node:*` external. electron-vite does this by
  default.
- **Keychain prompts.** The first `@napi-rs/keyring` read on macOS prompts to
  allow the Electron binary; in dev that is the Electron app, in a packaged
  build it is DDD. Documented in the README.
- **Launcher paths on Windows and Linux** were untested in the Rust too. Ported
  blind, marked as such.
- **DDD keeps moving.** The port targets `7fe0f68`. Changes landing in DDD
  after that are picked up per phase by re-reading the touched modules, and the
  handler contract test flags any new command.
