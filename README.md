# DDD on Node

De Developer Dashboard — the [Rust/Tauri app](../DDD) rebuilt on Electron with a
TypeScript backend. Same `~/.ddd` files, same keychain entries; the two apps can
share a home.

Design: `docs/superpowers/specs/2026-09-10-node-port-design.md`.

## Run

    npm install
    npm run dev:electron     # the desktop app, with HMR
    npm run dev              # browser preview of the renderer alone, localStorage-backed
    npm test                 # vitest: core, main and renderer
    npm run smoke            # build, boot, call global_load through the bridge, exit
    npm run build            # typecheck + electron-vite build → out/

If `npm install` could not download the Electron binary (proxy, offline
mirror, …), run `node node_modules/electron/install.js` once to fetch it.

Set `DDD_HOME` to keep a dev instance away from your real board.
`npm run smoke` uses a scratch `DDD_HOME` (a fresh temp directory, logged on
start) unless one is already set, so it never touches your real `~/.ddd`.
`DDD_SMOKE_SHOT=<path>` on `npm run smoke` also writes a PNG of the booted window to `<path>`.
A connection's token is stored in the OS keychain under service `ddd:<env>`, exactly as the Rust app stores it.

## Where things are

    src/core      the port of src-tauri/src — plain Node, never imports electron
    src/main      Electron host: window, ddd:invoke, dialogs, CSP
    src/preload   window.ddd
    src/renderer  the DDD frontend, copied from its HEAD; only lib/ipc.ts knows

## What is ported

| Phase | Contents | State |
|---|---|---|
| 0 | global.json, environments, layout, settings, keymap, events, secrets, paths; the app boots to the starter board | **done** |
| 1 | projects, launcher, `.ddd/` watching: register a folder, launch Claude Code in it, `/todo` reaches the card | **done** |
| 2 | sync engine, item cache, GitHub, OAuth, the approval gate; paste a GitHub token in Settings → Connections to see your PRs | **done** |
| 3 | AI actions (draft / summarize / tasks) over Anthropic, Ollama or an OpenAI-compatible endpoint, ICM project context, widget instructions compiled locally | **done** |
| 4 | Calendar (ICS feeds + local events, recurrence expansion), repos (scan/link/clone with progress), dev servers (list/probe/stop), end-of-life board (endoflife.date, cached) | **done** |
| 5 | Jira, Slack, Gmail, IMAP, MCP | |
| 6 | products, packaging, claude-code scripts | |

Platform notes: dev-server cwd resolution needs `lsof` on macOS and `/proc` on Linux; stopping a process is not offered on Windows; docker containers appear when the `docker` CLI is on `PATH`.

The first keychain access on macOS prompts to allow the Electron binary; in a
packaged build that will be DDD itself.
