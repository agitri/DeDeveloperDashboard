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

Set `DDD_HOME` to keep a dev instance away from your real board.
`DDD_SMOKE_SHOT=<path>` on `npm run smoke` also writes a PNG of the booted window to `<path>`.

## Where things are

    src/core      the port of src-tauri/src — plain Node, never imports electron
    src/main      Electron host: window, ddd:invoke, dialogs, CSP
    src/preload   window.ddd
    src/renderer  the DDD frontend, copied from its HEAD; only lib/ipc.ts knows

## What is ported

| Phase | Contents | State |
|---|---|---|
| 0 | global.json, environments, layout, settings, keymap, events, secrets, paths; the app boots to the starter board | **done** |
| 1 | projects, launcher, `.ddd/` watching | |
| 2 | sync engine, GitHub, the approval gate | |
| 3 | AI providers, ICM, widget instructions | |
| 4 | calendar, repos, dev servers, EOL | |
| 5 | Jira, Slack, Gmail, IMAP, MCP | |
| 6 | products, packaging, claude-code scripts | |

The first keychain access on macOS prompts to allow the Electron binary; in a
packaged build that will be DDD itself.
